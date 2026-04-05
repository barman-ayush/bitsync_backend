# 05_merge_algorithm — Merge Conflict Algorithm

## 1. Overview

Merge conflicts arise when a PR is merged and the workspace has **diverged** from the current repo HEAD. Both sides have made changes since their common ancestor, and some of those changes are incompatible.

The common ancestor is **computed dynamically** via `merge_base()` (see `01_storage/spec.md` §5.1), not read from a stored pointer. This ensures correctness even when a workspace has extra commits beyond what was merged in a previous PR.

```
Repo:       A → B → C → D (HEAD)
                     \
Workspace:            C → E → F (workspace.head)
                      ^
              merge_base(D, F) = C
```

This spec covers:
1. When and how to trigger a merge
2. Tree-level diffing (which files changed on each side)
3. Conflict detection, storage, and resolution
4. Building the final merged commit

---

## 2. Merge Triggers

A merge is triggered when a **PR is merged** into the repo. The system computes `merge_base()` to check for divergence:

```
function check_divergence(pr, repo):
    base = merge_base(repo.head_commit, pr.pr_head)

    if base == repo.head_commit:
        return FAST_FORWARD    // repo HEAD is an ancestor of pr_head, just move HEAD
    else:
        return DIVERGED        // three-way merge needed, base is the common ancestor
```

### 2.1 Fast-Forward (No Merge Needed)

```
Repo:       A → B → C (HEAD)
                     \
Workspace:            C → E → F (pr_head)

merge_base(C, F) = C = repo.head_commit → FAST_FORWARD

Result:     A → B → C → E → F (HEAD)
```

- `merge_base == repo.head_commit` — repo HEAD is an ancestor of pr_head, no one else committed since the workspace diverged
- Simply move `repo.head_commit` to `pr.pr_head`
- No merge commit, no conflicts possible

### 2.2 Diverged (Three-Way Merge)

```
Repo:       A → B ��� C → D (HEAD)
                     \
Workspace:            C → E → F (pr_head)

merge_base(D, F) = C

Three-way merge inputs:
  BASE   = commit C's root tree   (merge_base — the computed common ancestor)
  OURS   = commit D's root tree   (repo HEAD)
  THEIRS = commit F's root tree   (pr_head)
```

---

## 3. Data Model — Merge Tables

### 3.1 Merge State

Created when a diverged merge begins. Tracks the overall merge operation.

| Field            | Type       | Description                                              |
|-----------------|------------|----------------------------------------------------------|
| id              | UUID (PK)  | Unique merge identifier                                   |
| pr_id           | UUID (FK)  | The PR that triggered this merge                           |
| workspace_id    | UUID (FK)  | The source workspace                                       |
| base_commit     | TEXT (FK)  | Common ancestor commit (computed via `merge_base()`)       |
| ours_commit     | TEXT (FK)  | Repo HEAD at time of merge                                 |
| theirs_commit   | TEXT (FK)  | Workspace HEAD at time of merge                            |
| status          | ENUM       | `IN_PROGRESS` / `RESOLVED` / `ABORTED`                    |
| merged_tree     | TEXT (FK)  | Root tree hash of the auto-merged result (`NULL` until built) |
| created_at      | TIMESTAMP  | When the merge started                                     |
| updated_at      | TIMESTAMP  | Last update                                                |

### 3.2 Merge Conflict

One row per **file path** that has a conflict. Not created for cleanly merged files.

| Field            | Type       | Description                                              |
|-----------------|------------|----------------------------------------------------------|
| id              | UUID (PK)  | Unique conflict identifier                                 |
| merge_state_id  | UUID (FK)  | The merge this conflict belongs to                         |
| file_path       | TEXT       | Full path of the conflicted file                           |
| conflict_type   | ENUM       | `EDIT_EDIT` / `DELETE_EDIT` / `ADD_ADD` / `DIR_FILE`       |
| base_blob       | TEXT (FK)  | Blob hash in BASE (`NULL` if file didn't exist in BASE)    |
| ours_blob       | TEXT (FK)  | Blob hash in OURS (`NULL` if deleted in OURS)              |
| theirs_blob     | TEXT (FK)  | Blob hash in THEIRS (`NULL` if deleted in THEIRS)          |
| resolved_blob   | TEXT (FK)  | Blob hash of the resolved content (`NULL` until resolved)  |
| resolution      | ENUM       | `PENDING` / `TAKE_OURS` / `TAKE_THEIRS` / `MANUAL`        |
| resolved_at     | TIMESTAMP  | When this conflict was resolved                            |

**Note:** Hunk-level conflict tracking (per-region within a file) is a future feature. See `feature_content_merge.md`. Currently all conflicts are resolved at the whole-file level.

---

## 4. Algorithm: Tree-Level Three-Way Merge

Compares all file paths across BASE, OURS, and THEIRS trees to classify what changed on each side.

### 4.1 Algorithm

```
function three_way_tree_merge(base_commit, ours_commit, theirs_commit):

    // ──────────────────────────────────────────────
    // STEP 1: Flatten all three trees
    // ──────────────────────────────────────────────
    base_map   = flatten_tree(base_commit.root_tree)     // path → blob_hash
    ours_map   = flatten_tree(ours_commit.root_tree)     // path → blob_hash
    theirs_map = flatten_tree(theirs_commit.root_tree)   // path → blob_hash

    // ──────────────────────────────────────────────
    // STEP 2: Collect all unique file paths
    // ──────────────────────────────────────────────
    all_paths = union(base_map.keys(), ours_map.keys(), theirs_map.keys())
    // Exclude directory paths (those ending with "/") — we only diff files
    all_paths = filter(all_paths, path => NOT path.endsWith("/"))

    // ──────────────────────────────────────────────
    // STEP 3: Classify each path
    // ──────────────────────────────────────────────
    merged_paths = {}       // path → blob_hash (for the merged result)
    conflicts = []          // list of conflict records

    for path in all_paths:
        base_hash   = base_map.get(path, NULL)
        ours_hash   = ours_map.get(path, NULL)
        theirs_hash = theirs_map.get(path, NULL)

        change_ours   = classify(base_hash, ours_hash)
        change_theirs = classify(base_hash, theirs_hash)

        action = decide(change_ours, change_theirs, ours_hash, theirs_hash, base_hash, path)

        if action.type == "RESOLVED":
            if action.hash != NULL:
                merged_paths[path] = action.hash
            // else: file is deleted, don't include in merged tree

        elif action.type == "CONFLICT":
            conflicts.append(action.conflict)
            // [FUTURE] Content-level merge (line-by-line) for text files could
            // auto-merge non-overlapping edits before declaring a conflict.
            // See feature_content_merge.md. For now, all EDIT_EDIT conflicts
            // are resolved at the whole-file level — user picks OURS or THEIRS.

    return { merged_paths, conflicts }
```

### 4.2 Helper: Classify Change

```
function classify(base_hash, other_hash):
    if base_hash == NULL and other_hash == NULL:
        return UNCHANGED         // shouldn't happen (path wouldn't be in the set)
    elif base_hash == NULL and other_hash != NULL:
        return ADDED
    elif base_hash != NULL and other_hash == NULL:
        return DELETED
    elif base_hash == other_hash:
        return UNCHANGED
    else:
        return MODIFIED
```

### 4.3 Decision Table

```
function decide(change_ours, change_theirs, ours_hash, theirs_hash, base_hash, path):

    // ── Neither side changed ──
    if change_ours == UNCHANGED and change_theirs == UNCHANGED:
        return RESOLVED(base_hash)

    // ── Only one side changed ──
    if change_ours == UNCHANGED:
        if change_theirs == MODIFIED:  return RESOLVED(theirs_hash)
        if change_theirs == ADDED:     return RESOLVED(theirs_hash)
        if change_theirs == DELETED:   return RESOLVED(NULL)           // delete

    if change_theirs == UNCHANGED:
        if change_ours == MODIFIED:    return RESOLVED(ours_hash)
        if change_ours == ADDED:       return RESOLVED(ours_hash)
        if change_ours == DELETED:     return RESOLVED(NULL)           // delete

    // ── Both sides deleted ──
    if change_ours == DELETED and change_theirs == DELETED:
        return RESOLVED(NULL)

    // ── Both sides added ──
    if change_ours == ADDED and change_theirs == ADDED:
        if ours_hash == theirs_hash:
            return RESOLVED(ours_hash)     // identical add, no conflict
        else:
            return CONFLICT({
                file_path: path, conflict_type: "ADD_ADD",
                base_blob: NULL, ours_blob: ours_hash, theirs_blob: theirs_hash
            })

    // ── Both sides modified ──
    if change_ours == MODIFIED and change_theirs == MODIFIED:
        if ours_hash == theirs_hash:
            return RESOLVED(ours_hash)     // identical modification
        else:
            return CONFLICT({
                file_path: path, conflict_type: "EDIT_EDIT",
                base_blob: base_hash, ours_blob: ours_hash, theirs_blob: theirs_hash
            })

    // ── One deleted, other modified ──
    if change_ours == DELETED and change_theirs == MODIFIED:
        return CONFLICT({
            file_path: path, conflict_type: "DELETE_EDIT",
            base_blob: base_hash, ours_blob: NULL, theirs_blob: theirs_hash
        })

    if change_ours == MODIFIED and change_theirs == DELETED:
        return CONFLICT({
            file_path: path, conflict_type: "DELETE_EDIT",
            base_blob: base_hash, ours_blob: ours_hash, theirs_blob: NULL
        })
```

---

## 5. Content-Level Merge — Future Feature

Content-level merge (line-by-line three-way merge for text files) is a **future enhancement**. See `feature_content_merge.md` for the full algorithm, including Myers diff, hunk-level conflict tracking, and per-hunk resolution.

**Current behavior:** When both sides modify the same file differently (`EDIT_EDIT`), it is treated as a whole-file conflict. The user is shown both versions (OURS and THEIRS) and must pick one, or upload a manually merged version. No automatic line-level merging is attempted.

---

## 6. Merge Orchestration

Called by the PR spec's `merge_pr` (`04_pull_requests/spec.md` §4.7). The PR spec validates preconditions and detects fast-forward vs diverged; this spec owns the full merge execution.

### 6.1 Execute Merge

Entry point called from `merge_pr`. Computes the common ancestor, then detects fast-forward or delegates to three-way merge.

```
function execute_merge(pr, workspace, repo):

    // ──────────────────────────────────────────────
    // STEP 1: Compute common ancestor
    // ──────────────────────────────────────────────
    base = merge_base(repo.head_commit, pr.pr_head)

    // ──────────────────────────────────────────────
    // STEP 2: Check for fast-forward
    // ──────────────────────────────────────────────
    if base == repo.head_commit:
        return fast_forward_merge(pr, workspace, repo)
    else:
        return three_way_merge(pr, workspace, repo, base)
```

### 6.2 Fast-Forward Merge

No divergence — repo HEAD is an ancestor of pr_head (`merge_base == repo.head_commit`). The PR's commits are appended directly to the main line.

```
Repo:       A → B → C (HEAD)
                     \
Workspace:            C → E → F (pr_head)

merge_base(C, F) = C = repo.head_commit → fast-forward

Result:     A → B → C → E → F (HEAD)
```

```
function fast_forward_merge(pr, workspace, repo):

    // ──────────────────────────────────────────────
    // STEP 1: Advance repo HEAD to pr_head (with optimistic locking)
    // ──────────────────────────────────────────────
    // Uses pr.pr_head, NOT workspace.head.
    // Commits after pr_head remain in the workspace.
    rows = UPDATE repo SET head_commit = pr.pr_head
           WHERE id = repo.id AND head_commit = repo.head_commit
    if rows == 0:
        ERROR("Concurrent merge detected — repo HEAD moved. Abort and retry.")

    // ──────────────────────────────────────────────
    // STEP 2: Freeze snapshot onto PR
    // ──────────────────────────────────────────────
    // base_commit = the computed merge_base (which equals repo.head_commit for fast-forward)
    UPDATE pull_request SET
        status       = "MERGED",
        base_commit  = repo.head_commit,
        merge_commit = pr.pr_head,    // no separate merge commit in fast-forward
        updated_at   = now()
    WHERE id = pr.id
    // pr_head is already set and becomes immutable now that status = MERGED

    // ──────────────────────────────────────────────
    // STEP 3: Update workspace status
    // ──────────────────────────────────────────────
    // No fork_point mutation needed — merge_base is computed from the graph.
    // If workspace.head == pr_head, workspace is fully merged.
    // If workspace.head != pr_head, extra commits remain for a future PR.
    UPDATE workspace SET
        status     = "CLEAN",
        updated_at = now()
    WHERE id = workspace.id

    // ──────────────────────────────────────────────
    // STEP 4: Notify PR author
    // ──────────────────────────────────────────────
    createNotification(pr.author_id, "pr_merged", {
        repoId: repo.id, repoName: repo.name,
        prId: pr.id, prTitle: pr.title, mergeCommit: pr.pr_head
    })

    return { status: "MERGED", merge_type: "FAST_FORWARD" }
```

**What happens to commits after `pr_head`:**

```
Before merge:
  pr_head = F, workspace.head = H

  Workspace: C → E → F → G → H
                      ^         ^
                  pr_head    workspace.head

After fast-forward merge:
  Repo: A → B → C → E → F (HEAD)
  Workspace: head = H

  Commits G, H are still in the workspace.
  merge_base(F, H) = F → next PR can fast-forward again.
  User can open a new PR for them.
```

### 6.3 Three-Way Merge

Repo HEAD has moved since the workspace was forked — other PRs were merged in the meantime. The `base` parameter is the computed `merge_base()` passed from `execute_merge`.

```
Repo:       A → B → C → D (HEAD)
                     \
Workspace:            C → E → F (pr_head)

merge_base(D, F) = C

Three-way merge:
  BASE   = C (computed merge_base)
  OURS   = D (repo HEAD)
  THEIRS = F (pr_head)
```

```
function three_way_merge(pr, workspace, repo, base):

    // ──────────────────────────────────────────────
    // STEP 1: Determine merge inputs
    // ──────────────────────────────────────────────
    // IMPORTANT: THEIRS is pr.pr_head, not workspace.head.
    // The merge only considers commits included in the PR.
    // BASE is the computed merge_base, not a stored pointer.
    base_commit   = load_commit(base)
    ours_commit   = load_commit(repo.head_commit)
    theirs_commit = load_commit(pr.pr_head)

    // ──────────────────────────────────────────────
    // STEP 2: Create merge state
    // ──────────────────────────────────────────────
    merge_state = INSERT INTO merge_state (
        id:            new_uuid(),
        pr_id:         pr.id,
        workspace_id:  workspace.id,
        base_commit:   base,
        ours_commit:   repo.head_commit,
        theirs_commit: pr.pr_head,
        status:        "IN_PROGRESS",
        merged_tree:   NULL
    )

    // ──────────────────────────────────────────────
    // STEP 3: Run three-way tree merge (§4.1)
    // ──────────────────────────────────────────────
    result = three_way_tree_merge(base_commit, ours_commit, theirs_commit)

    // ──────────────────────────────────────────────
    // STEP 4: Build the merged tree
    // ──────────────────────────────────────────────
    // result.merged_paths is a flat path → blob_hash map
    // Rebuild tree objects bottom-up (reuse unchanged subtrees)
    merged_root_tree = build_tree_from_path_map(result.merged_paths)
    UPDATE merge_state SET merged_tree = merged_root_tree

    // ──────────────────────────────────────────────
    // STEP 5: Handle conflicts (if any)
    // ──────────────────────────────────────────────
    if result.conflicts is empty:
        // No conflicts — finalize immediately
        return finalize_merge(merge_state, pr, workspace, repo)

    // Store conflicts in DB
    for conflict in result.conflicts:
        INSERT INTO merge_conflict (
            id:              new_uuid(),
            merge_state_id:  merge_state.id,
            file_path:       conflict.file_path,
            conflict_type:   conflict.conflict_type,
            base_blob:       conflict.base_blob,
            ours_blob:       conflict.ours_blob,
            theirs_blob:     conflict.theirs_blob,
            resolved_blob:   NULL,
            resolution:      "PENDING"
        )

        // [FUTURE] When content-level merge is implemented, EDIT_EDIT conflicts
        // will also store individual conflict hunks. See feature_content_merge.md.

    // Mark workspace as conflicted
    UPDATE workspace SET status = "CONFLICTED"

    // Notify PR author about conflicts
    repo = SELECT * FROM repo WHERE id = pr.repo_id
    createNotification(pr.author_id, "merge_conflicts", {
        repoId: repo.id, repoName: repo.name,
        prId: pr.id, prTitle: pr.title,
        conflictCount: len(result.conflicts),
        mergeStateId: merge_state.id
    })

    return {
        status: "CONFLICTS_DETECTED",
        merge_state_id: merge_state.id,
        conflict_count: len(result.conflicts)
    }
```

### 6.4 Finalize Merge (After All Conflicts Resolved)

Called after all conflicts are resolved, or immediately by `three_way_merge` if the merge was clean.

```
function finalize_merge(merge_state, pr, workspace, repo):

    // ──────────────────────────────────────────────
    // STEP 1: Verify all conflicts resolved
    // ──────────────────────────────────────────────
    pending = SELECT count(*) FROM merge_conflict
              WHERE merge_state_id = merge_state.id AND resolution = "PENDING"
    ASSERT pending == 0

    // ──────────────────────────────────────────────
    // STEP 2: Rebuild final tree with resolved blobs
    // ──────────────────────────────────────────────
    // Start with the auto-merged path map, then replace conflicted paths
    // with their resolved blobs
    merged_paths = flatten_tree(merge_state.merged_tree)

    resolved_conflicts = SELECT * FROM merge_conflict
                         WHERE merge_state_id = merge_state.id

    for conflict in resolved_conflicts:
        if conflict.resolved_blob == NULL:
            // File was resolved as "delete"
            merged_paths.remove(conflict.file_path)
        else:
            merged_paths[conflict.file_path] = conflict.resolved_blob

    final_root_tree = build_tree_from_path_map(merged_paths)

    // ──────────────────────────────────────────────
    // STEP 3: Create merge commit
    // ──────────────────────────────────────────────
    commit_content = build_commit_content(
        tree:    final_root_tree,
        parents: [merge_state.ours_commit, merge_state.theirs_commit],
        author:  pr.author_id,
        message: "Merge PR #" + pr.id + ": " + pr.title
    )
    merge_commit_hash = SHA256("commit\0" + byte_length(commit_content) + "\0" + commit_content)

    INSERT INTO commit (commit_hash, root_tree, parent, author, timestamp, message, parent_workspace_id)
    VALUES (merge_commit_hash, final_root_tree, merge_state.ours_commit, pr.author_id, now(), "Merge PR #" + pr.id + ": " + pr.title, NULL)

    INSERT INTO commit_parents (commit_hash, parent_hash, ordinal)
    VALUES (merge_commit_hash, merge_state.ours_commit, 0)

    INSERT INTO commit_parents (commit_hash, parent_hash, ordinal)
    VALUES (merge_commit_hash, merge_state.theirs_commit, 1)

    // ──────────────────────────────────────────────
    // STEP 4: Advance repo HEAD (with optimistic locking)
    // ──────────────────────────────────────────────
    rows = UPDATE repo SET head_commit = merge_commit_hash
           WHERE id = repo.id AND head_commit = merge_state.ours_commit
    if rows == 0:
        ERROR("Concurrent merge detected — repo HEAD moved. Abort and retry.")

    // ──────────────────────────────────────────────
    // STEP 5: Freeze snapshot onto PR
    // ──────────────────────────────────────────────
    UPDATE pull_request SET
        status       = "MERGED",
        base_commit  = merge_state.base_commit,
        merge_commit = merge_commit_hash,
        updated_at   = now()
    WHERE id = pr.id
    // pr_head is already set and becomes immutable now that status = MERGED

    // ──────────────────────────────────────────────
    // STEP 6: Update workspace
    // ──────────────────────────────────────────────
    // No fork_point mutation — merge_base is computed from the commit graph.
    // The merge commit M records both parents (ours_commit and theirs_commit)
    // in commit_parents, so future merge_base() calls will find the correct
    // common ancestor by traversing M's second parent back to theirs_commit.
    //
    // If workspace.head == pr.pr_head, workspace is fully merged — advance
    // head to merge_commit so the workspace reflects the merged state.
    // If workspace.head != pr.pr_head, extra commits exist — head stays.
    if workspace.head == pr.pr_head:
        UPDATE workspace SET
            head       = merge_commit_hash,
            status     = "CLEAN",
            updated_at = now()
        WHERE id = workspace.id
    else:
        UPDATE workspace SET
            status     = "CLEAN",
            updated_at = now()
        WHERE id = workspace.id

    // ──────────────────────────────────────────────
    // STEP 7: Clean up merge state
    // ──────────────────────────────────────────────
    UPDATE merge_state SET status = "RESOLVED"

    // ──────────────────────────────────────────────
    // STEP 8: Notify PR author
    // ──────────────────────────────────────────────
    repo = SELECT * FROM repo WHERE id = pr.repo_id
    createNotification(pr.author_id, "pr_merged", {
        repoId: repo.id, repoName: repo.name,
        prId: pr.id, prTitle: pr.title, mergeCommit: merge_commit_hash
    })

    return { status: "MERGED", merge_type: "THREE_WAY", merge_commit: merge_commit_hash }
```

---

## 7. Conflict Resolution API

### 7.1 List Conflicts

```
GET /merges/{merge_state_id}/conflicts

Response:
{
    "merge_state_id": "...",
    "status": "IN_PROGRESS",
    "conflicts": [
        {
            "id": "...",
            "file_path": "src/main.py",
            "conflict_type": "EDIT_EDIT",
            "resolution": "PENDING",
            "base_blob": "def456...",
            "ours_blob": "abc123...",
            "theirs_blob": "789xyz..."
        },
        {
            "id": "...",
            "file_path": "config.yaml",
            "conflict_type": "DELETE_EDIT",
            "resolution": "PENDING",
            "base_blob": "aaa111...",
            "ours_blob": null,
            "theirs_blob": "abc123..."
        }
    ]
}
```

### 7.2 Resolve a Conflict (All Types)

All conflict types (EDIT_EDIT, DELETE_EDIT, ADD_ADD, DIR_FILE) are resolved at the **whole-file level**. The user picks one version or uploads a manual version.

```
POST /merges/{merge_state_id}/conflicts/{conflict_id}/resolve

Body:
{
    "resolution": "TAKE_OURS" | "TAKE_THEIRS" | "MANUAL",
    "content": "..."    // required only for MANUAL
}
```

**Algorithm:**

```
function resolve_conflict(conflict_id, user_id, resolution, manual_content):
    conflict = load_conflict(conflict_id)
    merge_state = SELECT * FROM merge_state WHERE id = conflict.merge_state_id
    pr = SELECT * FROM pull_request WHERE id = merge_state.pr_id

    // ──────────────────────────────────────────────
    // Permission check: only PR author, repo admins, or owner
    // ──────────────────────────────────────────────
    ASSERT user_id == pr.author_id
        OR user_has_repo_role(user_id, pr.repo_id, ["admin", "owner"])

    if resolution == "TAKE_OURS":
        resolved_hash = conflict.ours_blob       // may be NULL (delete)
    elif resolution == "TAKE_THEIRS":
        resolved_hash = conflict.theirs_blob      // may be NULL (delete)
    elif resolution == "MANUAL":
        new_blob = create_blob(manual_content)
        resolved_hash = new_blob.hash

    UPDATE merge_conflict SET
        resolved_blob = resolved_hash,
        resolution = resolution,
        resolved_at = now()
    WHERE id = conflict_id

    check_all_conflicts_resolved(conflict.merge_state_id)
```

### 7.3 Check If All Conflicts Resolved

```
function check_all_conflicts_resolved(merge_state_id):
    pending = SELECT count(*) FROM merge_conflict
              WHERE merge_state_id = merge_state_id AND resolution = "PENDING"

    if pending == 0:
        // All conflicts resolved — ready to finalize
        UPDATE merge_state SET status = "RESOLVED"
        UPDATE workspace SET status = "MERGING"    // ready for finalize
        // The client can now call finalize_merge
```

---

## 8. Conflict Type Summary

| Type | When | What the User Sees | Resolution Options |
|------|------|-------------------|-------------------|
| **EDIT_EDIT** | Both sides modified the same file with different content | Both file versions shown side-by-side | Whole-file: take ours, take theirs, or upload manual version |
| **DELETE_EDIT** | One side deleted, other modified | "File was deleted by repo but modified in your workspace" (or vice versa) | Keep the file (take the modified version) or delete it |
| **ADD_ADD** | Both sides created same path with different content | Two different file contents at the same path | Take ours, take theirs, or manually merge |
| **DIR_FILE** | One side created a file, other created a directory at the same path | "Path conflict: file vs directory" | Rename one, delete one, or restructure |

---

## 9. Merge Revert

If a merge produces incorrect results (bad conflict resolution, accidental merge), the user can **revert** it. A revert does not delete history — it creates a new commit that restores the pre-merge state.

### 9.1 Algorithm

```
function revert_merge(pr_id, user_id):

    // ──────────────────────────────────────────────
    // STEP 1: Load and validate
    // ──────────────────────────────────────────────
    pr   = SELECT * FROM pull_request WHERE id = pr_id
    repo = SELECT * FROM repo WHERE id = pr.repo_id

    ASSERT pr.status == "MERGED"
    ASSERT pr.merge_commit is not NULL

    // Only PR author, repo admins, or owner can revert
    ASSERT user_id == pr.author_id
        OR user_has_repo_role(user_id, pr.repo_id, ["admin", "owner"])

    // ──────────────────────────────────────────────
    // STEP 2: Find the pre-merge state
    // ──────────────────────────────────────────────
    // The merge commit's first parent (ordinal 0) is the repo HEAD
    // before the merge. Its tree is the state we want to restore.
    pre_merge_commit = SELECT parent_hash FROM commit_parents
                       WHERE commit_hash = pr.merge_commit AND ordinal = 0
    pre_merge_tree = load_commit(pre_merge_commit).root_tree

    // ──────────────────────────────────────────────
    // STEP 3: Create revert commit
    // ──────────────────────────────────────────────
    // The revert commit has the current repo HEAD as parent
    // and the pre-merge tree as its root_tree.
    // This effectively "undoes" the merge by restoring the old tree.
    revert_content = build_commit_content(
        tree:    pre_merge_tree,
        parents: [repo.head_commit],
        author:  user_id,
        message: "Revert \"Merge PR #" + pr.id + ": " + pr.title + "\""
    )
    revert_hash = SHA256("commit\0" + byte_length(revert_content) + "\0" + revert_content)

    INSERT INTO commit (commit_hash, root_tree, parent, author, timestamp, message, parent_workspace_id)
    VALUES (revert_hash, pre_merge_tree, repo.head_commit, user_id, now(), revert_content.message, NULL)

    INSERT INTO commit_parents (commit_hash, parent_hash, ordinal)
    VALUES (revert_hash, repo.head_commit, 0)

    // ──────────────────────────────────────────────
    // STEP 4: Advance repo HEAD (with optimistic locking)
    // ──────────────────────────────────────────────
    rows = UPDATE repo SET head_commit = revert_hash
           WHERE id = repo.id AND head_commit = repo.head_commit
    if rows == 0:
        ERROR("Concurrent modification — repo HEAD moved. Retry.")

    // ──────────────────────────────────────────────
    // STEP 5: Emit notification
    // ──────────────────────────────────────────────
    createNotification(pr.author_id, "pr_reverted", {
        repoId: repo.id,
        repoName: repo.name,
        prId: pr.id,
        prTitle: pr.title,
        revertedBy: user_id,
        revertCommit: revert_hash
    })

    return { status: "REVERTED", revert_commit: revert_hash }
```

### 9.2 What a Revert Does NOT Do

- Does **not** change the PR's status — it stays `MERGED`. The merge happened; the revert is a separate commit.
- Does **not** delete the merge commit — history is preserved, the revert is additive.
- Does **not** restore the workspace to pre-merge state — the workspace's `fork_point` is unchanged.
- The reverted changes can be re-merged by opening a new PR. `merge_base()` will correctly compute the common ancestor from the graph.

---

## 10. Edge Cases

### 10.1 Empty Merge (No Changes)
If `merge_base(repo.head_commit, pr.pr_head) == pr.pr_head`, the PR's commits are already in the repo history. Reject the merge — nothing to merge. (This is checked by the PR spec's validation: `pr_head` must have commits beyond the common ancestor.)

### 10.2 Workspace Has Uncommitted Changes
If `workspace_changes` is not empty when a merge is triggered, reject it. The user must commit or discard changes first. Cannot merge dirty state.

### 10.3 Concurrent Merges
Two PRs merged simultaneously could both read the same `repo.head_commit` and try to advance it. Use **optimistic locking**:
```
UPDATE repo SET head_commit = new_hash
WHERE id = repo_id AND head_commit = expected_old_hash
// If 0 rows affected → someone else merged first → retry or abort
```

### 10.4 Conflict During Rebase
In rebase mode, each workspace commit is replayed one-by-one. A conflict can arise at **any replay step**. The merge state must track which commit is currently being replayed:

```
Additional field on merge_state:
  rebase_current_commit: TEXT   // which workspace commit is being replayed
  rebase_completed:      INT    // how many commits have been successfully replayed
  rebase_total:          INT    // total workspace commits to replay
```

### 10.5 Abort Merge
User can abort a merge in progress:
```
function abort_merge(merge_state_id):
    // Delete all conflicts
    DELETE FROM merge_conflict WHERE merge_state_id = merge_state_id

    // Reset workspace status
    UPDATE workspace SET status = "CLEAN"
    WHERE id = (SELECT workspace_id FROM merge_state WHERE id = merge_state_id)

    // Mark merge as aborted
    UPDATE merge_state SET status = "ABORTED"
```

### 10.6 File Renamed on One Side

Without rename detection, renames appear as a DELETE + ADD pair, causing false conflicts. This section specifies how to detect and handle renames during the three-way merge.

#### 10.6.1 The Problem

If OURS renames `a.py → b.py` and THEIRS modifies `a.py`:
- Tree-level diff sees: OURS deleted `a.py` + added `b.py`; THEIRS modified `a.py`
- Without rename detection: DELETE_EDIT conflict on `a.py`, and `b.py` appears as a new file
- The user must manually realize this was a rename and apply their edits to `b.py`

#### 10.6.2 Rename Detection Algorithm

Run rename detection as a **post-processing step** after `three_way_tree_merge` (§4.1) produces its initial `merged_paths` and `conflicts` list, but before returning results.

```
function detect_renames(base_map, ours_map, theirs_map, conflicts):

    // ──────────────────────────────────────────────
    // STEP 1: Collect candidate pairs
    // ──────────────────────────────────────────────
    // Find files that were DELETED on one side and ADDED on the same side.
    // If the deleted file's base_blob == added file's blob, it's a rename.

    ours_deleted  = { path: base_map[path] for path in base_map if path NOT in ours_map }
    ours_added    = { path: ours_map[path]  for path in ours_map  if path NOT in base_map }

    theirs_deleted = { path: base_map[path] for path in base_map if path NOT in theirs_map }
    theirs_added   = { path: theirs_map[path] for path in theirs_map if path NOT in base_map }

    renames = []

    // ──────────────────────────────────────────────
    // STEP 2: Match deleted → added by blob hash (exact match)
    // ──────────────────────────────────────────────
    // Check OURS side: deleted file's base blob == added file's blob
    for del_path, del_hash in ours_deleted:
        for add_path, add_hash in ours_added:
            if del_hash == add_hash:
                renames.append({
                    side:      "OURS",
                    old_path:  del_path,
                    new_path:  add_path,
                    blob_hash: del_hash
                })
                ours_added.remove(add_path)
                break    // one match per deleted file

    // Same for THEIRS side
    for del_path, del_hash in theirs_deleted:
        for add_path, add_hash in theirs_added:
            if del_hash == add_hash:
                renames.append({
                    side:      "THEIRS",
                    old_path:  del_path,
                    new_path:  add_path,
                    blob_hash: del_hash
                })
                theirs_added.remove(add_path)
                break

    return renames
```

#### 10.6.3 Applying Renames to Conflict Resolution

After detecting renames, rewrite the affected conflicts:

```
function apply_rename_resolution(renames, conflicts, merged_paths, base_map, ours_map, theirs_map):

    for rename in renames:

        // ──────────────────────────────────────────
        // CASE 1: OURS renamed, THEIRS modified the old path
        // ──────────────────────────────────────────
        if rename.side == "OURS":
            theirs_blob = theirs_map.get(rename.old_path)

            if theirs_blob is not NULL and theirs_blob != base_map[rename.old_path]:
                // THEIRS modified the file at the old path.
                // Apply THEIRS' changes to the new path instead.
                // Remove the DELETE_EDIT conflict on old_path.
                remove_conflict(conflicts, rename.old_path)

                // The file at new_path has OURS' (renamed, unchanged content).
                // Replace it with THEIRS' modified version at the new path.
                // This is an EDIT_EDIT on the new path — OURS has the original
                // content (just renamed), THEIRS has modified content.
                merged_paths[rename.new_path] = theirs_blob
                merged_paths.remove(rename.old_path)    // ensure old path deleted

            elif theirs_blob is NULL:
                // THEIRS also deleted the old path — both sides agree it's gone.
                // Keep the rename (file exists at new_path via OURS).
                remove_conflict(conflicts, rename.old_path)

        // ──────────────────────────────────────────
        // CASE 2: THEIRS renamed, OURS modified the old path
        // ──────────────────────────────────────────
        if rename.side == "THEIRS":
            ours_blob = ours_map.get(rename.old_path)

            if ours_blob is not NULL and ours_blob != base_map[rename.old_path]:
                // OURS modified the file at the old path.
                // Apply OURS' changes to the new path instead.
                remove_conflict(conflicts, rename.old_path)
                merged_paths[rename.new_path] = ours_blob
                merged_paths.remove(rename.old_path)

            elif ours_blob is NULL:
                // OURS also deleted — both agree. Keep rename.
                remove_conflict(conflicts, rename.old_path)
```

#### 10.6.4 Rename Conflict: Both Sides Renamed Same File Differently

```
OURS:   a.py → b.py
THEIRS: a.py → c.py
```

Both appear as DELETE of `a.py` + ADD of different paths. After rename detection, both sides deleted the same file and added different new files. This is a **rename-rename conflict**:

- `a.py` is deleted on both sides → RESOLVED (delete)
- `b.py` exists only in OURS → RESOLVED (keep)
- `c.py` exists only in THEIRS → RESOLVED (keep)
- **Both files survive** at their respective new paths. No conflict — both renames are applied.

If both sides renamed to the **same** new path but with different content, this falls through to ADD_ADD conflict on the new path (already handled by §4.3).

#### 10.6.5 Limitations

- **Exact match only:** Rename detection requires identical blob hashes (the file content must be unchanged). If a file is renamed AND modified, the blob hashes differ, and it appears as an unrelated delete + add. Fuzzy rename detection (similarity threshold) is a future enhancement.
- **One-to-one:** Each deleted file matches at most one added file. If the same content appears at multiple new paths, only the first match is treated as a rename.
