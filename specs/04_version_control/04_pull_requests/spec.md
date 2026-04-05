# 04_pull_requests — Pull Request Specification

## 1. Overview

A Pull Request (PR) proposes merging a workspace's commits into the repository's main line. It wraps a workspace and provides a review, discussion, and merge workflow.

Key design decisions:
- A PR is **tied to a workspace** — the workspace is the source of commits.
- New commits to the workspace **automatically appear** in the PR (no selective inclusion — see §1.1).
- While open, the PR's commit range is **derived live** from the workspace. On merge, it is **frozen** as a permanent snapshot.
- A PR can be **closed and reopened** without losing state.

### 1.1 `pr_head` — Selective Commit Inclusion

By default, a PR includes all commits from the computed `merge_base(repo.head_commit, pr_head)` (exclusive) to `pr_head` (inclusive). When a PR is created, `pr_head` is set to `workspace.head` at that time.

New commits pushed to the workspace do **not** automatically advance `pr_head`. The user must explicitly include them. This gives the user control over what's in the PR.

**Rules:**
- `pr_head` can only be advanced **forward** along the workspace's commit chain, never backward.
- A commit can only be included if its parent is already in the PR (i.e., its parent == current `pr_head`). This ensures the PR always contains a **contiguous chain**.
- The merge operation uses `pr_head`, not `workspace.head`.

```
Workspace:  C → E → F → G → H
                     ^         ^
                 pr_head    workspace.head

PR contains: [E, F]
Commits G, H are in the workspace but NOT in the PR.

User advances pr_head to G → PR contains: [E, F, G]
User cannot advance pr_head to H and skip G.
User cannot advance pr_head directly to H without first including G.
```

**After merge:** Commits between `pr_head` and `workspace.head` (if any) remain in the workspace. The user can open a new PR for them.

---

## 2. Data Model Changes

The PR table from the storage spec (§3.8) is extended with `pr_head`:

| Field          | Type       | Description                                             |
|---------------|------------|---------------------------------------------------------|
| id            | UUID (PK)  | Unique PR identifier                                     |
| repo_id       | UUID (FK)  | Target repository                                        |
| workspace_id  | UUID (FK)  | Source workspace                                         |
| author_id     | UUID (FK)  | User who created the PR                                  |
| title         | TEXT       | PR title                                                 |
| description   | TEXT       | PR description                                           |
| status        | ENUM       | `OPEN` / `MERGED` / `CLOSED`                             |
| pr_head       | TEXT (FK)  | Latest commit included in the PR (user-controlled). Becomes immutable once status is `MERGED`. |
| base_commit   | TEXT (FK)  | Frozen computed `merge_base()` at merge time (`NULL` while open) |
| merge_commit  | TEXT (FK)  | Resulting merge/fast-forward commit (`NULL` until merged) |
| created_at    | TIMESTAMP  | Creation time                                            |
| updated_at    | TIMESTAMP  | Last update time                                         |

**Changes from storage spec:**
- `status` enum simplified to `OPEN` / `MERGED` / `CLOSED` (see CRIT-04 in known-issues — approval state is derived from reviews, not stored on the PR).
- `pr_head` added — the user-controlled pointer to the latest included commit. Becomes immutable once the PR is merged (MERGED is terminal).
- `head_commit` removed — redundant with `pr_head`. Since MERGED is terminal, `pr_head` is already frozen by definition once merged.

---

## 3. PR Lifecycle — State Machine

```
OPEN → MERGED     (PR merged successfully)
OPEN → CLOSED     (author or admin closes without merging)
CLOSED → OPEN     (author or admin reopens)
```

**MERGED is terminal** — a merged PR cannot be reopened or closed. To undo a merge, create a revert commit (see HIGH-08 in known-issues).

---

## 4. Algorithms

### 4.1 Create PR

```
function create_pr(repo_id, workspace_id, author_id, title, description):

    // ──────────────────────────────────────────────
    // STEP 1: Load and validate
    // ──────────────────────────────────────────────
    workspace = SELECT * FROM workspace WHERE id = workspace_id
    repo      = SELECT * FROM repo WHERE id = repo_id

    ASSERT workspace.repo_id == repo_id
    ASSERT workspace.user_id == author_id

    // ──────────────────────────────────────────────
    // STEP 2: Ensure workspace has commits beyond the common ancestor
    // ──────────────────────────────────────────────
    // pr_head will be set to workspace.head — if head is already
    // an ancestor of (or equal to) repo HEAD, the PR would have zero commits.
    base = merge_base(repo.head_commit, workspace.head)
    ASSERT workspace.head != base

    // ──────────────────────────────────────────────
    // STEP 3: Ensure no open PR already exists for this workspace
    // ──────────────────────────────────────────────
    existing = SELECT * FROM pull_request
               WHERE workspace_id = workspace_id AND status = 'OPEN'
    ASSERT existing is empty

    // ──────────────────────────────────────────────
    // STEP 4: Ensure workspace has no uncommitted changes
    // NOTE - In future we will remove this validation check.
    // ──────────────────────────────────────────────
    pending = SELECT count(*) FROM workspace_changes
              WHERE workspace_id = workspace_id
    ASSERT pending == 0

    // ──────────────────────────────────────────────
    // STEP 5: Create the PR
    // ──────────────────────────────────────────────
    pr = INSERT INTO pull_request (
        id:           new_uuid(),
        repo_id:      repo_id,
        workspace_id: workspace_id,
        author_id:    author_id,
        title:        title,
        description:  description,
        status:       "OPEN",
        pr_head:      workspace.head,
        base_commit:  NULL,
        merge_commit: NULL,
        created_at:   now(),
        updated_at:   now()
    )

    return pr
```

### 4.2 Update PR Head (Include New Commits)

Advances `pr_head` to include newly pushed commits.

```
function update_pr_head(pr_id, new_pr_head):

    // ──────────────────────────────────────────────
    // STEP 1: Load and validate
    // ──────────────────────────────────────────────
    pr        = SELECT * FROM pull_request WHERE id = pr_id
    workspace = SELECT * FROM workspace WHERE id = pr.workspace_id

    ASSERT pr.status == "OPEN"

    // ──────────────────────────────────────────────
    // STEP 2: Verify new_pr_head is a valid commit
    // ──────────────────────────────────────────────
    commit = SELECT * FROM commit WHERE commit_hash = new_pr_head
    ASSERT commit exists

    // ──────────────────────────────────────────────
    // STEP 3: Verify contiguity — new_pr_head's parent must be current pr_head
    // ──────────────────────────────────────────────
    // This ensures we're advancing by exactly one commit.
    // To advance by multiple commits, call this function repeatedly
    // or verify the full chain in a single check (see batch variant below).
    ASSERT commit.parent == pr.pr_head

    // ──────────────────────────────────────────────
    // STEP 4: Update
    // ──────────────────────────────────────────────
    UPDATE pull_request SET
        pr_head    = new_pr_head,
        updated_at = now()
    WHERE id = pr_id

    return pr
```

**Batch variant — advance by multiple commits at once:**

```
function update_pr_head_batch(pr_id, new_pr_head):
    // Same as above, but instead of checking parent == pr_head,
    // verify the full chain: walk from new_pr_head back to pr.pr_head.
    // Every commit in between must exist and be in the workspace chain.

    pr = SELECT * FROM pull_request WHERE id = pr_id
    ASSERT pr.status == "OPEN"

    // Walk backward from new_pr_head to pr.pr_head
    current = new_pr_head
    while current != pr.pr_head:
        commit = SELECT * FROM commit WHERE commit_hash = current
        ASSERT commit exists
        ASSERT is_ancestor_of(current, workspace.head)
        current = commit.parent
        if current is NULL:
            ERROR("new_pr_head is not a descendant of current pr_head")

    UPDATE pull_request SET
        pr_head    = new_pr_head,
        updated_at = now()
    WHERE id = pr_id
```

### 4.3 Get PR Commit Chain

Returns the ordered list of commits included in the PR.

```
function get_pr_commits(pr_id):
    pr        = SELECT * FROM pull_request WHERE id = pr_id
    workspace = SELECT * FROM workspace WHERE id = pr.workspace_id

    // Determine boundaries
    if pr.status == "MERGED":
        // pr_head is frozen (MERGED is terminal), base_commit is the frozen merge_base
        start = pr.pr_head
        stop  = pr.base_commit
    else:
        // Derive live: compute merge_base between repo HEAD and pr_head
        repo = SELECT * FROM repo WHERE id = pr.repo_id
        start = pr.pr_head
        stop  = merge_base(repo.head_commit, pr.pr_head)

    // Walk parent chain from start back to stop (exclusive)
    commits = []
    current = start
    while current != stop:
        commit = SELECT * FROM commit WHERE commit_hash = current
        commits.append(commit)
        current = commit.parent
        if current is NULL:
            ERROR("merge_base not found in parent chain — broken history")

    // Reverse so oldest commit is first
    return commits.reverse()
```

**Example:**
```
merge_base = C, pr_head = F

Walk: F → E → C (stop)
Reversed: [E, F]
```

### 4.4 Get PR Diff (Aggregate)

Returns the aggregate file-level diff across all PR commits — comparing the state at the common ancestor to the state at `pr_head`.

```
function get_pr_diff(pr_id):
    pr        = SELECT * FROM pull_request WHERE id = pr_id
    workspace = SELECT * FROM workspace WHERE id = pr.workspace_id

    if pr.status == "MERGED":
        base_tree = load_commit(pr.base_commit).root_tree
        head_tree = load_commit(pr.pr_head).root_tree
    else:
        repo = SELECT * FROM repo WHERE id = pr.repo_id
        base = merge_base(repo.head_commit, pr.pr_head)
        base_tree = load_commit(base).root_tree
        head_tree = load_commit(pr.pr_head).root_tree

    // Flatten both trees into path → blob_hash maps
    base_map = flatten_tree(base_tree)
    head_map = flatten_tree(head_tree)

    diff = []

    // Files in base but not in head → DELETED
    for path, info in base_map:
        if info.type != "blob": continue
        if path NOT in head_map:
            diff.append({ file_path: path, status: "DELETED", base_blob: info.hash, head_blob: NULL })
        elif head_map[path].hash != info.hash:
            diff.append({ file_path: path, status: "MODIFIED", base_blob: info.hash, head_blob: head_map[path].hash })

    // Files in head but not in base → ADDED
    for path, info in head_map:
        if info.type != "blob": continue
        if path NOT in base_map:
            diff.append({ file_path: path, status: "ADDED", base_blob: NULL, head_blob: info.hash })

    return {
        base_commit: pr.base_commit or base,
        pr_head:     pr.pr_head,
        files:       diff
    }
```

### 4.5 Close PR

```
function close_pr(pr_id, user_id):
    pr = SELECT * FROM pull_request WHERE id = pr_id

    ASSERT pr.status == "OPEN"

    // Only author or repo admin/owner can close
    ASSERT user_id == pr.author_id OR user_has_repo_role(user_id, pr.repo_id, ["admin", "owner"])

    UPDATE pull_request SET
        status     = "CLOSED",
        updated_at = now()
    WHERE id = pr_id

    return pr
```

No fields are nulled — the workspace reference, `pr_head`, title, description all remain intact.

### 4.6 Reopen PR

```
function reopen_pr(pr_id, user_id):
    pr = SELECT * FROM pull_request WHERE id = pr_id

    ASSERT pr.status == "CLOSED"

    // Only author or repo admin/owner can reopen
    ASSERT user_id == pr.author_id OR user_has_repo_role(user_id, pr.repo_id, ["admin", "owner"])

    // Ensure the workspace still exists
    workspace = SELECT * FROM workspace WHERE id = pr.workspace_id
    ASSERT workspace exists

    // Ensure no other open PR for this workspace
    existing = SELECT * FROM pull_request
               WHERE workspace_id = pr.workspace_id AND status = 'OPEN'
    ASSERT existing is empty

    // Ensure pr_head is still reachable from workspace.head
    // (workspace may have been modified since PR was closed)
    // Uses is_ancestor_of which walks all parents (see 01_storage/spec.md §5.1)
    ASSERT is_ancestor_of(pr.pr_head, workspace.head)

    // Ensure PR still has commits beyond the common ancestor
    repo = SELECT * FROM repo WHERE id = pr.repo_id
    base = merge_base(repo.head_commit, pr.pr_head)
    ASSERT pr.pr_head != base    // if equal, commits were already merged — can't reopen

    UPDATE pull_request SET
        status     = "OPEN",
        updated_at = now()
    WHERE id = pr_id

    return pr
```

### 4.7 Merge PR

The merge algorithm coordinates the full flow — precondition checks, divergence detection, and delegation to the appropriate merge strategy.

```
function merge_pr(pr_id, user_id):

    // ──────────────────────────────────────────────
    // STEP 1: Load and validate
    // ──────────────────────────────────────────────
    pr        = SELECT * FROM pull_request WHERE id = pr_id
    workspace = SELECT * FROM workspace WHERE id = pr.workspace_id
    repo      = SELECT * FROM repo WHERE id = pr.repo_id

    ASSERT pr.status == "OPEN"
    ASSERT workspace.status == "CLEAN"

    // ──────────────────────────────────────────────
    // STEP 2: Ensure no uncommitted changes in workspace
    // ──────────────────────────────────────────────
    pending = SELECT count(*) FROM workspace_changes
              WHERE workspace_id = workspace.id
    ASSERT pending == 0

    // ──────────────────────────────────────────────
    // STEP 3: Ensure PR has commits beyond common ancestor
    // ──────────────────────────────────────────────
    base = merge_base(repo.head_commit, pr.pr_head)
    ASSERT pr.pr_head != base

    // ──────────────────────────────────────────────
    // STEP 4: Check divergence
    // ──────────────────────────────────────────────
    // Delegate to merge algorithm spec (05_merge_algorithm/spec.md §6)
    return execute_merge(pr, workspace, repo)
```

### 4.8 Helper: `is_ancestor_of` and `merge_base`

These are defined in `01_storage/spec.md` §5.1. Both walk **all parents** via the `commit_parents` table, not just `commit.parent`. This is critical for correctness after merge commits — without multi-parent traversal, commits reachable via a merge commit's second parent would be invisible.

---

## 5. API Endpoints

| Method | Endpoint                            | Description                              | Algorithm |
|--------|-------------------------------------|------------------------------------------|-----------|
| POST   | `/repos/{repo_id}/pulls`            | Create a new PR                          | §4.1      |
| GET    | `/repos/{repo_id}/pulls`            | List PRs (filterable by status)          | —         |
| GET    | `/repos/{repo_id}/pulls/{pr_id}`    | Get PR details                           | —         |
| PATCH  | `/repos/{repo_id}/pulls/{pr_id}`    | Update PR title/description              | —         |
| GET    | `/repos/{repo_id}/pulls/{pr_id}/commits` | Get PR commit chain                 | §4.3      |
| GET    | `/repos/{repo_id}/pulls/{pr_id}/diff`    | Get aggregate PR diff                | §4.4      |
| POST   | `/repos/{repo_id}/pulls/{pr_id}/advance` | Advance `pr_head` to include commits | §4.2      |
| POST   | `/repos/{repo_id}/pulls/{pr_id}/merge`   | Merge the PR                         | §4.7      |
| POST   | `/repos/{repo_id}/pulls/{pr_id}/close`   | Close without merging                | §4.5      |
| POST   | `/repos/{repo_id}/pulls/{pr_id}/reopen`  | Reopen a closed PR                   | §4.6      |

---

## 6. Edge Cases

### 6.1 Uncommitted Changes at Merge Time
**Rejected.** Both `create_pr` and `merge_pr` assert that `workspace_changes` is empty. The user must commit or discard changes before creating/merging a PR.

### 6.2 Empty PR (No Commits)
**Rejected.** `create_pr` computes `merge_base(repo.head, workspace.head)` and asserts `workspace.head != base`. A PR with zero new commits cannot be created.

### 6.3 Workspace Deleted While PR is Open
The PR becomes orphaned — `workspace_id` points to a deleted row. Querying the PR's live commit chain fails because the workspace (and its `head`) no longer exist.

**Mitigation:** Block workspace deletion if an open PR references it (see HIGH-06 in known-issues).

### 6.4 Concurrent PR Merges
Two PRs targeting the same repo merged simultaneously. Both read the same `repo.head_commit`, both create merge commits with the same `ours_commit` parent. The optimistic locking in `05_merge_algorithm/spec.md` §6.4 catches this — the second merge fails and must retry with the updated HEAD.

See CRIT-03 in known-issues for the full analysis.

### 6.5 Workspace Modified While PR is Open
The user pushes more commits to the workspace after creating the PR. Because `pr_head` is separate from `workspace.head`, the PR is unaffected. The new commits only appear in the PR when the user explicitly advances `pr_head` (§4.2).

### 6.6 `pr_head` Becomes Unreachable
If the workspace is somehow reset (head moved backward), `pr_head` may no longer be reachable from `workspace.head`. This is an invalid state.

**Mitigation:** Workspace head must never move backward (workspace operations are append-only). If we ever support revert/reset, the PR's `pr_head` must be validated and adjusted.

### 6.7 Reopen After Previous Merge
If another PR was merged from the same workspace between close and reopen, the PR's commits may already be in the repo's history.

**Mitigation:** On reopen, compute `merge_base(repo.head, pr_head)`. If `merge_base == pr_head`, the commits are already merged — the PR cannot be reopened. The user should create a new PR for any new commits.

### 6.8 Merge with Extra Commits in Workspace

```
Workspace: C → E → F → G → H
                     ^         ^
                 pr_head    workspace.head
```

The merge only considers [E, F]. G and H remain in the workspace. The workspace is in a valid state — user can continue working and open a new PR.

**Three-way merge case:** The merge commit M's tree reflects the state at `pr_head` (F) merged with repo HEAD. M records both parents: repo HEAD (ordinal 0) and F (ordinal 1). When the user later creates a PR for G and H, `merge_base(M, H)` walks M's second parent to find F — the true divergence point. The three-way merge correctly uses BASE=F, and G and H's changes are merged cleanly without losing any prior work.
