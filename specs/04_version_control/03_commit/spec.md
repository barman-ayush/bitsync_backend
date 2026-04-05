# 03_commit — Specifications

## 1. Fetch Repository File Tree

Resolves the full file/folder structure from a commit for client display.

### 1.1 Approach: Lazy Loading (One Level at a Time)

The client requests one directory level per API call. Subdirectories are fetched on-demand as the user expands them in the UI. This avoids loading the entire tree for large repos.

### 1.2 API

```
GET /repos/{repo_id}/tree/{tree_hash}

Response:
{
  "tree_hash": "abc123...",
  "entries": [
    { "name": "src",       "type": "tree", "object_hash": "def456..." },
    { "name": "README.md", "type": "blob", "object_hash": "ghi789...", "size": 1024 },
    { "name": "config.json","type": "blob", "object_hash": "jkl012...", "size": 256 }
  ]
}
```

For the initial load, the client first fetches the commit to get the root tree hash:
```
GET /repos/{repo_id}/head        → { "commit_hash": "...", "root_tree": "abc123..." }
GET /repos/{repo_id}/tree/abc123 → { entries for root directory }
```

For workspaces, the same pattern applies but starting from the workspace head:
```
GET /workspaces/{workspace_id}/head → { "commit_hash": "...", "root_tree": "abc123..." }
```

### 1.3 Algorithm: Resolve Tree

```
// FETCHES - COMMITTED CHANGES ONLY
function resolve_tree(tree_hash):
    // 1. Load tree entries from DB
    entries = SELECT name, entry_type, object_hash
              FROM tree_entry
              WHERE parent_tree = tree_hash
              ORDER BY entry_type DESC, name ASC    // folders first, then files, alphabetical

    // 2. For blob entries, batch-fetch sizes in a single JOIN query
    //    (avoids N+1: one query instead of one per blob)
    entries = SELECT te.name, te.entry_type, te.object_hash, b.size
              FROM tree_entry te
              LEFT JOIN blob b ON te.entry_type = 'blob' AND te.object_hash = b.blob_hash
              WHERE te.parent_tree = tree_hash
              ORDER BY te.entry_type DESC, te.name ASC

    // 3. Return entries (client decides when to expand subtrees)
    return {
        tree_hash: tree_hash,
        entries: entries
    }
```

### 1.4 Algorithm: Resolve Tree with Uncommitted Changes (Workspace View)

When displaying a workspace, the client needs to see the **committed tree + uncommitted changes overlaid**. This gives the user a view of their current working state.

**How `current_path` is constructed:**

`current_path` is a **directory prefix** built by the client as the user navigates the file tree. It is NOT a value from `workspace_changes.file_path` — it is constructed from tree entry names:

1. **Root call:** Client starts with `current_path = ""`
2. **User clicks a folder:** Client appends `entry.name + "/"` to the current prefix

```
User opens root         → current_path = ""
User clicks "src"       → current_path = "" + "src" + "/" = "src/"
User clicks "lib"       → current_path = "src/" + "lib" + "/" = "src/lib/"
```

The trailing `/` exists only in these constructed prefixes — it is never stored in the database. It enables prefix-matching against `workspace_changes.file_path` values (which are always files like `"src/main.py"`, never directories).

```
// FETCHES - COMBINED COMMITTED AND UNCOMMITTED CHANGES
function resolve_workspace_tree(workspace_id, tree_hash, current_path):
    // 1. Load committed tree entries (same as above)
    committed_entries = resolve_tree(tree_hash).entries

    // 2. Load uncommitted changes that affect this directory level
    //    e.g., if current_path = "src/", find changes where file_path starts with "src/"
    //    but only the immediate children (not deeper nested)
    //    Note: current_path is "" for root, so this matches ALL file_paths at root level
    changes = SELECT file_path, action, blob_hash
              FROM workspace_changes
              WHERE workspace_id = workspace_id
              AND file_path LIKE current_path + '%'

    // 3. Filter to immediate children of current_path
    //    "src/main.py"       → immediate child "main.py"       ✓
    //    "src/utils/helper.py" → immediate child "utils/"       ✓ (implies folder)
    //    "tests/test.py"     → not under current_path           ✗
    immediate_changes = {}
    for change in changes:
        relative = change.file_path.removePrefix(current_path)
        segments = relative.split("/")
        // segments = ["main.py"] for direct childrens
        // segments = ["utils" ,"helper.py"] for subtrees.

        if segments.length == 1:
            // Direct file in this directory
            immediate_changes[segments[0]] = change
        else:
            // File in a subdirectory — mark that subdirectory as modified
            // In our case : segments[0] + "/" = "utils/"
            immediate_changes[segments[0] + "/"] = { action: "SUBTREE_MODIFIED" }

    // 4. Merge committed entries with uncommitted changes
    result = []
    for entry in committed_entries:
        change = immediate_changes.remove(entry.name)
        if change == null:
            // No uncommitted change for this entry
            result.append({ ...entry, status: "COMMITTED" })
        elif change.action == "DELETE":
            // File/folder was deleted in uncommitted changes
            result.append({ ...entry, status: "DELETED" })
        elif change.action == "MODIFY":
            // File was modified — show new blob hash + size
            result.append({
                name: entry.name,
                type: "blob",
                object_hash: change.blob_hash,
                size: SELECT size FROM blob WHERE blob_hash = change.blob_hash,
                status: "MODIFIED"
            })
        elif change.action == "SUBTREE_MODIFIED":
            // A file deeper in this subtree was changed
            result.append({ ...entry, status: "SUBTREE_MODIFIED" })

    // 5. Remaining changes are ADDs (new files/folders not in committed tree)
    for name, change in immediate_changes:
        if change.action == "ADD":
            result.append({
                name: name,
                type: "blob",
                object_hash: change.blob_hash,
                size: SELECT size FROM blob WHERE blob_hash = change.blob_hash,
                status: "ADDED"
            })
        elif change.action == "SUBTREE_MODIFIED":
            // New subdirectory implied by a new file in a nested path
            result.append({
                name: name.removeSuffix("/"),
                type: "tree",
                object_hash: null,    // no committed tree exists yet
                status: "ADDED"
            })

    return {
        tree_hash: tree_hash,
        entries: sorted(result, by: type DESC, name ASC)
    }
```

### 1.5 Status Values for Workspace View

| Status | Meaning |
|--------|---------|
| `COMMITTED` | No uncommitted changes — same as in the last commit |
| `MODIFIED` | File content changed but not yet committed |
| `ADDED` | New file/folder not present in the last commit |
| `DELETED` | File/folder removed but deletion not yet committed |
| `SUBTREE_MODIFIED` | A folder whose contents have uncommitted changes somewhere inside |

---

## 2. Commit Creation

Takes uncommitted workspace changes, creates the necessary blob/tree objects (reusing unchanged subtrees), and produces a new commit.

### 2.1 Inputs

```
Input:
  - workspace_id
  - author          (from authenticated user)
  - message         (commit message from user)

Derived:
  - workspace       = load workspace by workspace_id
  - parent_commit   = load commit by workspace.head
  - changes         = load all workspace_changes for workspace_id
```

### 2.2 Preconditions

- `changes` must not be empty (reject empty commits)
- `workspace.status` must be `CLEAN` (cannot commit while in `MERGING` or `CONFLICTED` state)

### 2.3 Algorithm: Build New Tree from Changes

The core idea: **only rebuild trees along the path from each changed file to the root.** All other subtrees are reused by hash reference.

```
function build_tree_from_changes(parent_commit, changes):

    // ──────────────────────────────────────────────
    // STEP 1: Flatten the parent commit's tree into a path map
    // ──────────────────────────────────────────────
    // Walk the parent commit's root tree recursively and produce a flat map
    // of every file path to its blob hash.
    //
    // Example:
    //   "README.md"        → { type: "blob", hash: "aaa..." }
    //   "src/main.py"      → { type: "blob", hash: "bbb..." }
    //   "src/utils.py"     → { type: "blob", hash: "ccc..." }
    //   "docs/readme.md"   → { type: "blob", hash: "ddd..." }

    path_map = flatten_tree(parent_commit.root_tree)

    // ──────────────────────────────────────────────
    // STEP 2: Apply changes to the flat path map
    // ──────────────────────────────────────────────

    for change in changes:
        if change.action == "ADD":
            if path_map.has(change.file_path):
                ERROR("File already exists: " + change.file_path)
            path_map[change.file_path] = { type: "blob", hash: change.blob_hash }

        elif change.action == "MODIFY":
            if NOT path_map.has(change.file_path):
                ERROR("File does not exist: " + change.file_path)
            path_map[change.file_path] = { type: "blob", hash: change.blob_hash }

        elif change.action == "DELETE":
            if NOT path_map.has(change.file_path):
                ERROR("File does not exist: " + change.file_path)
            path_map.remove(change.file_path)

    // ──────────────────────────────────────────────
    // STEP 3: Determine which directories are affected
    // ──────────────────────────────────────────────
    // A directory is "dirty" if any file inside it (at any depth) was changed.
    // Only dirty directories need new tree objects. Clean directories are reused.
    //
    // Example: if only "src/main.py" was modified:
    //   dirty: "src/", ""(root)
    //   clean: "docs/"  → reuse entire subtree

    dirty_dirs = set()
    for change in changes:
        // Mark every ancestor directory as dirty
        segments = change.file_path.split("/")
        for i in range(len(segments) - 1):    // exclude the filename itself
            dir_path = "/".join(segments[0:i+1]) + "/"
            dirty_dirs.add(dir_path)
        dirty_dirs.add("")    // root is always dirty if there are changes

    // ──────────────────────────────────────────────
    // STEP 4: Rebuild trees bottom-up
    // ──────────────────────────────────────────────
    // Process directories from deepest to shallowest.
    // For each dirty directory, build a new tree object.
    // For clean directories, reuse the existing tree hash from the parent commit.

    // Sort dirty dirs by depth (deepest first)
    sorted_dirs = sort(dirty_dirs, by: count("/"), descending)

    // Cache: dir_path → tree_hash (for newly built trees)
    new_tree_hashes = {}

    // Load the parent commit's directory structure for reuse lookups
    // dir_path → tree_hash (from parent commit)
    parent_dir_map = build_dir_hash_map(parent_commit.root_tree)

    for dir_path in sorted_dirs:
        entries = []

        // Collect all immediate children of this directory
        children = get_immediate_children(path_map, dir_path)

        for child_name, child_info in children:
            if child_info.type == "blob":
                // File entry — use the blob hash from path_map
                entries.append({
                    entry_type: "blob",
                    name: child_name,
                    object_hash: child_info.hash
                })
            else:
                // Subdirectory
                child_dir_path = dir_path + child_name + "/"

                if child_dir_path in dirty_dirs:
                    // Dirty subtree — use the newly computed hash
                    entries.append({
                        entry_type: "tree",
                        name: child_name,
                        object_hash: new_tree_hashes[child_dir_path]
                    })
                else:
                    // Clean subtree — REUSE the existing tree hash
                    // Guard: if the directory is new (not in parent commit),
                    // it MUST be in dirty_dirs. If we reach here, the directory
                    // existed in the parent commit and is unchanged.
                    if child_dir_path NOT in parent_dir_map:
                        ERROR("Bug: clean subtree " + child_dir_path + " not found in parent. "
                              + "New directories must be in dirty_dirs.")
                    entries.append({
                        entry_type: "tree",
                        name: child_name,
                        object_hash: parent_dir_map[child_dir_path]
                    })

        // Compute tree hash for this directory
        tree_hash = compute_tree_hash(entries)    // see storage spec section 4.2

        // Store tree + entries in DB if this hash doesn't already exist (dedup)
        if NOT exists_in_db(tree_hash):
            INSERT INTO tree (tree_hash) VALUES (tree_hash)
            for entry in entries:
                INSERT INTO tree_entry (id, parent_tree, entry_type, name, object_hash)
                VALUES (new_uuid(), tree_hash, entry.entry_type, entry.name, entry.object_hash)

        new_tree_hashes[dir_path] = tree_hash

    // The root tree hash is the final result
    return new_tree_hashes[""]
```

**Example: Adding a file in a new subdirectory**

This demonstrates CRIT-01 — adding `src/lib/helper.py` where `src/lib/` never existed:

```
Parent tree:
  README.md       → blob aaa
  src/main.py     → blob bbb
  src/utils.py    → blob ccc

Change: ADD src/lib/helper.py → blob ddd

STEP 2: path_map gains "src/lib/helper.py" → { blob, ddd }

STEP 3: dirty_dirs = { "src/lib/", "src/", "" }
         "src/lib/" is dirty because helper.py was added inside it.

STEP 4 (bottom-up):
  Process "src/lib/" (deepest):
    children: helper.py (blob ddd)
    → new tree hash for src/lib/

  Process "src/" (dirty):
    children: main.py (blob bbb), utils.py (blob ccc), lib/ (dirty → use new_tree_hashes["src/lib/"])
    → new tree hash for src/

  Process "" (root):
    children: README.md (blob aaa), src/ (dirty → use new_tree_hashes["src/"])
    → new root tree hash

Note: "src/lib/" is NOT in parent_dir_map (it didn't exist before).
But it IS in dirty_dirs, so the guard clause is never reached for it.
The guard only fires for clean subtrees — if "src/lib/" were somehow
clean AND missing from parent_dir_map, that would be a bug, and the
guard clause catches it.
```

### 2.4 Algorithm: Create Commit

```
function create_commit(workspace_id, author, message):

    // ──────────────────────────────────────────────
    // STEP 1: Load workspace and validate
    // ──────────────────────────────────────────────
    workspace = SELECT * FROM workspace WHERE id = workspace_id
    ASSERT workspace.status == "CLEAN"

    changes = SELECT * FROM workspace_changes WHERE workspace_id = workspace_id
    ASSERT changes is not empty

    parent_commit = SELECT * FROM commit WHERE commit_hash = workspace.head

    // ──────────────────────────────────────────────
    // STEP 2: Ensure all blobs exist
    // ──────────────────────────────────────────────
    // Blobs should have been uploaded before the commit request.
    // Validate that every ADD/MODIFY change references an existing blob.
    for change in changes:
        if change.action in ("ADD", "MODIFY"):
            ASSERT EXISTS (SELECT 1 FROM blob WHERE blob_hash = change.blob_hash)

    // ──────────────────────────────────────────────
    // STEP 3: Build the new root tree
    // ──────────────────────────────────────────────
    new_root_tree = build_tree_from_changes(parent_commit, changes)

    // ──────────────────────────────────────────────
    // STEP 4: Compute commit hash (Git format — see storage spec 4.3)
    // ──────────────────────────────────────────────
    timestamp = current_unix_timestamp()
    timezone = author_timezone()    // e.g., "+0530"

    commit_content = build_commit_content(
        tree:      new_root_tree,
        parents:   [workspace.head],
        author:    author,
        timestamp: timestamp,
        timezone:  timezone,
        message:   message
    )

    commit_hash = SHA256("commit\0" + byte_length(commit_content) + "\0" + commit_content)

    // ──────────────────────────────────────────────
    // STEP 5: Store the commit
    // ──────────────────────────────────────────────
    INSERT INTO commit (commit_hash, root_tree, parent, author, timestamp, message, parent_workspace_id)
    VALUES (commit_hash, new_root_tree, workspace.head, author, timestamp, message, workspace_id)

    // ──────────────────────────────────────────────
    // STEP 6: Update workspace state (with optimistic locking)
    // ──────────────────────────────────────────────
    // Compare-and-swap on workspace.head to prevent concurrent commits
    // from silently overwriting each other. If two commits read the same
    // workspace.head, both compute trees from the same parent. Without
    // this check, the second commit would overwrite the first.
    rows = UPDATE workspace
           SET head = commit_hash,
               updated_at = now()
           WHERE id = workspace_id AND head = workspace.head
    if rows == 0:
        ERROR("Concurrent commit detected — workspace head moved. Retry.")

    // ──────────────────────────────────────────────
    // STEP 7: Clear uncommitted changes
    // ──────────────────────────────────────────────
    DELETE FROM workspace_changes WHERE workspace_id = workspace_id

    return commit_hash
```

### 2.5 Helper: Flatten Tree

Recursively walks a tree and produces a flat path → hash map.

```
MAX_TREE_DEPTH = 256

function flatten_tree(tree_hash, prefix = "", depth = 0):
    if depth > MAX_TREE_DEPTH:
        ERROR("Maximum directory nesting depth (256) exceeded at: " + prefix)

    path_map = {}

    entries = SELECT * FROM tree_entry WHERE parent_tree = tree_hash

    for entry in entries:
        full_path = prefix + entry.name

        if entry.entry_type == "blob":
            path_map[full_path] = { type: "blob", hash: entry.object_hash }
        elif entry.entry_type == "tree":
            // Recurse into subdirectory
            sub_paths = flatten_tree(entry.object_hash, full_path + "/", depth + 1)
            path_map.merge(sub_paths)
            // Also record the directory itself for reuse lookups
            path_map[full_path + "/"] = { type: "tree", hash: entry.object_hash }

    return path_map
```

### 2.6 Helper: Build Directory Hash Map

Extracts dir_path → tree_hash from the parent commit for reuse lookups.

```
function build_dir_hash_map(root_tree_hash, prefix = ""):
    dir_map = {}
    dir_map[prefix] = root_tree_hash    // "" → root hash for the root level

    entries = SELECT * FROM tree_entry WHERE parent_tree = root_tree_hash

    for entry in entries:
        if entry.entry_type == "tree":
            child_path = prefix + entry.name + "/"
            dir_map[child_path] = entry.object_hash
            // Recurse
            sub_dirs = build_dir_hash_map(entry.object_hash, child_path)
            dir_map.merge(sub_dirs)

    return dir_map
```

### 2.7 Helper: Get Immediate Children

Given the flat path map and a directory path, returns only the immediate children.

```
function get_immediate_children(path_map, dir_path):
    children = {}

    for path, info in path_map:
        if NOT path.startsWith(dir_path):
            continue
        if path == dir_path:
            continue    // skip the directory itself

        relative = path.removePrefix(dir_path)
        segments = relative.split("/")

        if info.type == "blob" AND segments.length == 1:
            // Direct file child: "main.py"
            children[segments[0]] = info
        elif segments.length >= 1:
            // Subdirectory child: "utils/" (from "utils/helper.py")
            children[segments[0]] = { type: "tree" }

    return children
```

---

## 3. Walkthrough: Commit with Tree Reuse

A concrete example showing how the algorithm works end-to-end.

### 3.1 Initial State

```
Repo HEAD commit (hash: COMMIT_A) points to root tree:

root/ (tree: ROOT_1)
├── src/ (tree: SRC_1)
│   ├── main.py    (blob: BLOB_M1)
│   └── utils.py   (blob: BLOB_U1)
├── docs/ (tree: DOCS_1)
│   └── readme.md  (blob: BLOB_R1)
└── config.json    (blob: BLOB_C1)
```

### 3.2 User Makes Changes

```
workspace_changes:
  { file_path: "src/main.py",      action: MODIFY, blob_hash: BLOB_M2 }
  { file_path: "src/lib/helper.py", action: ADD,    blob_hash: BLOB_H1 }
  { file_path: "config.json",       action: DELETE, blob_hash: NULL    }
```

### 3.3 Step-by-Step Execution

**Step 1 — Flatten parent tree:**
```
path_map = {
    "src/main.py":    { blob, BLOB_M1 },
    "src/utils.py":   { blob, BLOB_U1 },
    "docs/readme.md": { blob, BLOB_R1 },
    "config.json":    { blob, BLOB_C1 },
    "src/":           { tree, SRC_1   },
    "docs/":          { tree, DOCS_1  },
}
```

**Step 2 — Apply changes:**
```
MODIFY "src/main.py"       → path_map["src/main.py"] = { blob, BLOB_M2 }
ADD    "src/lib/helper.py" → path_map["src/lib/helper.py"] = { blob, BLOB_H1 }
DELETE "config.json"       → path_map.remove("config.json")

Result:
    "src/main.py":        { blob, BLOB_M2 }    ← changed
    "src/utils.py":       { blob, BLOB_U1 }    ← unchanged
    "src/lib/helper.py":  { blob, BLOB_H1 }    ← new
    "docs/readme.md":     { blob, BLOB_R1 }    ← unchanged
```

**Step 3 — Determine dirty directories:**
```
Change: "src/main.py"       → dirty: "src/", ""
Change: "src/lib/helper.py" → dirty: "src/", "src/lib/", ""
Change: "config.json"       → dirty: ""

dirty_dirs = { "src/lib/", "src/", "" }
clean dirs = { "docs/" }
```

**Step 4 — Rebuild bottom-up:**

Process `"src/lib/"` (deepest):
```
Children: helper.py (BLOB_H1)
Entries:  [{ blob, "helper.py", BLOB_H1 }]
Hash:     SHA256("tree\0blob helper.py\0BLOB_H1") → LIB_1
Result:   new tree LIB_1 created
```

Process `"src/"`:
```
Children: main.py (BLOB_M2), utils.py (BLOB_U1), lib/ (dirty → LIB_1)
Entries:  [{ tree, "lib", LIB_1 }, { blob, "main.py", BLOB_M2 }, { blob, "utils.py", BLOB_U1 }]
Hash:     → SRC_2
Result:   new tree SRC_2 created
```

Process `""` (root):
```
Children: src/ (dirty → SRC_2), docs/ (clean → DOCS_1, REUSED)
Entries:  [{ tree, "docs", DOCS_1 }, { tree, "src", SRC_2 }]
Hash:     → ROOT_2
Result:   new tree ROOT_2 created
```

### 3.4 Final State

```
root/ (tree: ROOT_2) ← NEW
├── src/ (tree: SRC_2) ← NEW
│   ├── lib/ (tree: LIB_1) ← NEW
│   │   └── helper.py (blob: BLOB_H1) ← NEW
│   ├── main.py    (blob: BLOB_M2) ← NEW blob
│   └── utils.py   (blob: BLOB_U1) ← REUSED
├── docs/ (tree: DOCS_1) ← REUSED (entire subtree)
│   └── readme.md  (blob: BLOB_R1) ← REUSED
                                       config.json ← DELETED

Objects created:  3 trees (ROOT_2, SRC_2, LIB_1) + 0 blobs (already uploaded)
Objects reused:   1 tree (DOCS_1) + 3 blobs (BLOB_U1, BLOB_R1, BLOB_H1)
```

### 3.5 New Commit

```
COMMIT_B:
  root_tree:           ROOT_2
  parent:              COMMIT_A
  parent_workspace_id: <workspace_id>
  author:              "Ayush"
  message:             "add helper lib, update main, remove config"

Workspace updated:
  head:  COMMIT_A → COMMIT_B
  workspace_changes:  cleared
```

---

## 4. Complexity Analysis

### 4.1 Fetch Tree

| Operation | Complexity |
|-----------|-----------|
| Resolve one directory level | O(k) where k = number of entries in that directory |
| Full tree (all levels) | O(n) where n = total number of files in the repo |
| With workspace overlay | O(k + c) where c = number of uncommitted changes in that directory |

### 4.2 Commit Creation

| Operation | Complexity |
|-----------|-----------|
| Flatten parent tree | O(n) where n = total files in repo |
| Apply changes | O(c) where c = number of changes |
| Determine dirty dirs | O(c * d) where d = max directory depth |
| Rebuild trees | O(dirty_dirs * avg_children) |
| Total | O(n) dominated by the flatten step |

**Key optimization:** The flatten step is the bottleneck. For very large repos, this could be optimized by:
- Caching the flat path map per commit (since commits are immutable)
- Only loading subtrees that are actually affected by changes (lazy flatten along dirty paths only)

### 4.3 Space Efficiency (Tree Reuse)

If a commit changes `c` files in a repo with `n` total files across `t` trees:
- **New trees created:** O(c * d) — only trees along the dirty paths
- **Trees reused:** O(t - c * d) — everything else
- **New blobs:** 0 at commit time (uploaded beforehand)

For typical commits (c << n), the vast majority of tree objects are reused.
