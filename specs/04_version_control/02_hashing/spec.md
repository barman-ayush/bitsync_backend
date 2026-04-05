# 02_hashing — Hashing Specification

## 1. Overview

BitSync uses **SHA-256** as its sole hashing algorithm across all object types. Every stored object — blob, tree, commit — is **content-addressed**: its identity (hash) is deterministically derived from its content. This means:

- Identical content always produces the same hash.
- Any change, no matter how small, produces a completely different hash.
- Objects can be **verified** by recomputing their hash from their content (tamper detection).

The tree hashing scheme forms a **Merkle tree** — a change in any descendant file propagates through every ancestor directory hash up to the root. This provides **integrity guarantees** over the entire repository state with a single root hash comparison.

---

## 2. Hash Function: SHA-256

All hashing uses **SHA-256** (256-bit / 32-byte output, represented as a 64-character lowercase hex string).

| Property             | Value                          |
|----------------------|--------------------------------|
| Algorithm            | SHA-256 (SHA-2 family)         |
| Output size          | 256 bits (32 bytes)            |
| Hex representation   | 64 lowercase hex characters    |
| Collision resistance | 2^128                          |

**Why SHA-256 over SHA-1:**
- SHA-1 is considered cryptographically broken (practical collision attacks exist since 2017).
- Git originally used SHA-1 and has been migrating to SHA-256.
- SHA-256 provides a comfortable security margin for content-addressed storage.

---

## 3. Blob Hash (File Hashing)

A blob stores the raw content of a single file. The blob hash uniquely identifies that content.

### 3.1 Formula

```
BLOB_HASH = SHA256( "blob" + "\0" + size + "\0" + file_content_in_bytes )
```

| Component               | Description                                                      |
|------------------------|------------------------------------------------------------------|
| `"blob"`               | Type tag — distinguishes blob hashes from tree/commit hashes     |
| `"\0"` (first)         | Null byte separator                                              |
| `size`                 | Byte length of `file_content_in_bytes`, encoded as a decimal ASCII string (e.g., `"11"` for 11 bytes) |
| `"\0"` (second)        | Null byte separator between header and content                   |
| `file_content_in_bytes`| The raw file content (binary)                                    |

### 3.2 Properties

- **Content-addressed:** Two files with identical byte content produce the same blob hash, regardless of filename, path, or file type.
- **Size-prefixed:** Including the byte length in the hash input prevents length-extension ambiguities.
- **Type-tagged:** The `"blob"` prefix ensures a blob can never collide with a tree or commit hash, even if the raw bytes happen to match.
- **Git-compatible:** This matches Git's blob hashing scheme (substituting SHA-256 for SHA-1).

### 3.3 Examples

**Example 1 — Simple text file:**
```
File: hello.txt
Content: "hello world" (11 bytes, no trailing newline)

Hash input bytes: "blob\011\0hello world"
                   ^^^^  ^^  ^^^^^^^^^^^
                   type  size  content

BLOB_HASH = SHA256("blob\011\0hello world")
```

**Example 2 — Empty file:**
```
File: empty.txt
Content: "" (0 bytes)

Hash input bytes: "blob\00\0"
BLOB_HASH = SHA256("blob\00\0")
```

**Example 3 — Binary file:**
```
File: image.png
Content: <raw PNG bytes> (48,291 bytes)

Hash input bytes: "blob\048291\0<raw PNG bytes>"
BLOB_HASH = SHA256("blob\048291\0<raw PNG bytes>")
```

### 3.4 Deduplication Guarantee

Because blobs are keyed by hash:
- Uploading the same file twice (even with different names) creates **one** blob in storage.
- Two users uploading identical files reference the **same** blob.
- Renaming a file does **not** change its blob hash — only the tree entry changes.

---

## 4. Tree Hash (Folder / Directory Hashing)

A tree represents a directory. Its hash is a **Merkle hash** — computed from the names, types, and hashes of its immediate children. This means a change to any file anywhere in the subtree propagates upward through every ancestor tree to the root.

### 4.1 Algorithm

**Step 1 — Build child strings:**

For each child entry in the directory, create a string:
```
"<type> <name>\0<object_hash>"
```

Where:
- `<type>` is `"blob"` (file) or `"tree"` (subdirectory)
- `<name>` is the entry name (filename or subdirectory name, **not** a full path)
- `"\0"` is a null byte separator
- `<object_hash>` is the SHA-256 hash of the referenced blob or child tree

**Step 2 — Sort by name:**

Sort all child strings **lexicographically by name**. This ensures determinism — the same set of children always produces the same hash regardless of insertion order.

**Step 3 — Concatenate:**

Concatenate all sorted child strings into a single byte sequence.

**Step 4 — Hash:**

```
TREE_HASH = SHA256( "tree\0" + concatenated_sorted_child_strings )
```

### 4.2 Properties

- **Merkle tree:** Changing a file's content changes its blob hash → changes its parent tree hash → changes every ancestor tree hash up to the root. A single root hash comparison can verify the integrity of the entire repository.
- **Name-sensitive:** Renaming a file changes the tree hash (the name is part of the hash input), even if the file's content is unchanged.
- **Structure-sensitive:** Two directories with the same files but different names produce different tree hashes.
- **Content-deterministic:** Two directories with identical structure, names, and content at every level produce the **same** tree hash — enabling subtree deduplication and reuse.
- **Order-independent:** Because entries are sorted by name before concatenation, the hash is independent of the order in which entries were added.

### 4.3 Examples

**Example 1 — Simple directory:**
```
Directory: src/
  ├── main.py    (blob, hash = abc123...)
  └── utils.py   (blob, hash = def456...)

Child strings (sorted by name):
  "blob main.py\0abc123..."
  "blob utils.py\0def456..."

Concatenated: "blob main.py\0abc123...blob utils.py\0def456..."

TREE_HASH = SHA256("tree\0blob main.py\0abc123...blob utils.py\0def456...")
```

**Example 2 — Directory with subdirectory:**
```
Directory: root/
  ├── README.md  (blob, hash = aaa111...)
  └── src/       (tree, hash = bbb222...)

Child strings (sorted by name):
  "blob README.md\0aaa111..."
  "tree src\0bbb222..."

TREE_HASH = SHA256("tree\0blob README.md\0aaa111...tree src\0bbb222...")
```

**Example 3 — Empty directory:**
```
Directory: empty_dir/
  (no children)

TREE_HASH = SHA256("tree\0")
```

> **Note:** In practice, empty directories may not exist in the object model since directories are implied by their entries. This is documented for completeness.

### 4.4 Merkle Propagation — Walkthrough

Consider a repo with this structure:

```
root/ (TREE_R1)
├── src/ (TREE_S1)
│   ├── main.py  (BLOB_M1)
│   └── utils.py (BLOB_U1)
└── docs/ (TREE_D1)
    └── readme.md (BLOB_R1)
```

If the user modifies `src/main.py` (new content → `BLOB_M2`):

1. `BLOB_M2` is stored (new blob hash, different from `BLOB_M1`)
2. `src/` tree must be **recomputed** because a child changed → `TREE_S2`
3. `root/` tree must be **recomputed** because `src/` changed → `TREE_R2`
4. `docs/` tree is **unchanged** → `TREE_D1` is **reused** (no recomputation needed)

```
root/ (TREE_R2) ← NEW
├── src/ (TREE_S2) ← NEW
│   ├── main.py  (BLOB_M2) ← NEW
│   └── utils.py (BLOB_U1) ← REUSED
└── docs/ (TREE_D1) ← REUSED (entire subtree)
    └── readme.md (BLOB_R1) ← REUSED
```

Only the path from the changed file to the root is recomputed. Everything else is reused by hash reference. This is the **key efficiency property** of Merkle trees.

---

## 5. Commit Hash

A commit is a snapshot of the entire repository at a point in time. The commit hash is computed over a structured content string that includes the root tree, parent(s), author, committer, and message.

### 5.1 Formula

**Step 1 — Build the commit content string:**

```
tree <root_tree_hash>\n
parent <parent_hash>\n          ← one line per parent; omitted entirely for the initial commit
author <name> <email> <unix_timestamp> <timezone>\n
committer <name> <email> <unix_timestamp> <timezone>\n
\n
<message>
```

**Step 2 — Hash with type+size header:**

```
COMMIT_HASH = SHA256( "commit" + "\0" + byte_length(content) + "\0" + content )
```

### 5.2 Content Fields

| Field             | Description                                                            |
|-------------------|------------------------------------------------------------------------|
| `root_tree_hash`  | SHA-256 hash of the root tree for this snapshot                        |
| `parent_hash`     | SHA-256 hash of the parent commit. Multiple `parent` lines for merge commits. Omitted for the initial (root) commit. |
| `name`            | Author/committer display name                                          |
| `email`           | Author/committer email (angle-bracket-wrapped in the content string)   |
| `unix_timestamp`  | Seconds since Unix epoch (e.g., `1743264000`)                          |
| `timezone`        | UTC offset (e.g., `+0530`, `+0000`, `-0800`)                          |
| `message`         | Free-form commit message (may contain newlines)                        |

### 5.3 Rules

- **Initial commit:** The `parent` line is **omitted entirely** (not set to null or empty).
- **Normal commit:** Exactly one `parent` line.
- **Merge commit:** Multiple `parent` lines, one per parent, **in order**. The first parent is the main-line parent; the second is the branch being merged in.
- **Author vs committer:** In BitSync, these are typically the same. The distinction exists for compatibility with Git's model (e.g., cherry-picks where the original author differs from the committer).
- **Determinism:** The same tree, parents, author info, timestamp, and message always produce the same commit hash. This means commits are **not** idempotently re-creatable — the timestamp ensures each commit is unique even if everything else is identical.

### 5.4 Examples

**Example 1 — Initial commit (no parent):**
```
Content:
  tree 8a7f2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a\n
  author Ayush <ayush@example.com> 1743264000 +0530\n
  committer Ayush <ayush@example.com> 1743264000 +0530\n
  \n
  initial commit: project scaffold

byte_length(content) = 221

COMMIT_HASH = SHA256("commit\0221\0<content>")
```

**Example 2 — Normal commit (single parent):**
```
Content:
  tree 9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c\n
  parent 3c9d1e2f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d\n
  author Ayush <ayush@example.com> 1743350400 +0530\n
  committer Ayush <ayush@example.com> 1743350400 +0530\n
  \n
  fix: resolve workspace sync issue

COMMIT_HASH = SHA256("commit\0<byte_length>\0<content>")
```

**Example 3 — Merge commit (two parents):**
```
Content:
  tree aabbccdd...\n
  parent 1111aaaa... \n
  parent 2222bbbb... \n
  author Ayush <ayush@example.com> 1743436800 +0530\n
  committer Ayush <ayush@example.com> 1743436800 +0530\n
  \n
  merge: integrate feature workspace

COMMIT_HASH = SHA256("commit\0<byte_length>\0<content>")
```

### 5.5 Why Timestamp Is Included

Including the timestamp ensures that two otherwise-identical commits (same tree, same parent, same message, same author) created at different times produce **different hashes**. Without this, re-creating a commit after a reset could silently alias to the old one, breaking history semantics.

---

## 6. PR Hash (Pull Request Hashing)

A Pull Request does **not** have a content-addressed hash in the same way blobs, trees, and commits do — PRs are mutable entities (status changes, new commits pushed, reviews added). However, the **merge snapshot** of a PR is fully identified by its commit hashes.

### 6.1 PR Identity via Commits

When a PR is merged, three commit hashes are frozen as a permanent record:

| Field           | Description                                                      |
|-----------------|------------------------------------------------------------------|
| `base_commit`   | The computed `merge_base()` at merge time — the common ancestor  |
| `head_commit`   | The `workspace.head` at merge time — the tip of the workspace    |
| `merge_commit`  | The resulting merge/fast-forward commit — the new repo HEAD      |

These three hashes together **uniquely and immutably identify** the exact state of a PR at merge time:
- `base_commit` → what the workspace was forked from
- `head_commit` → what the workspace contained when merged
- `merge_commit` → the resulting snapshot after merge

### 6.2 Deriving a PR Fingerprint

For scenarios that require a single hash to represent a PR (e.g., audit logs, integrity checks, deduplication of identical merges), a **PR fingerprint** can be derived:

```
PR_FINGERPRINT = SHA256(
    "pr" + "\0"
    + base_commit_hash + "\0"
    + head_commit_hash + "\0"
    + merge_commit_hash
)
```

This fingerprint is:
- **Deterministic:** Same base/head/merge commits always produce the same fingerprint.
- **Tamper-evident:** Altering any of the three commit references changes the fingerprint.
- **Post-merge only:** Can only be computed after the PR is merged (when all three hashes are available).

### 6.3 PR Commit Chain

The full set of commits in a PR is the chain from `base_commit` (exclusive) to `head_commit` (inclusive):

```
base_commit → C1 → C2 → ... → Cn (head_commit)
```

Each commit in this chain is individually hashed (Section 5). The integrity of the entire chain is guaranteed by the parent-linking:
- `head_commit`'s hash covers its parent hash
- That parent's hash covers *its* parent hash
- ...all the way back to `base_commit`

This means verifying `head_commit`'s hash implicitly verifies the integrity of the **entire commit chain** — a change to any commit in the chain would produce a different `head_commit` hash.

### 6.4 Verifying a Merged PR

To verify the integrity of a merged PR:

1. **Verify the merge commit:** Recompute `merge_commit`'s hash from its content (tree, parents, author, message). It must match the stored hash.
2. **Verify parent linkage:** The merge commit's parents must include both `base_commit` (or current repo HEAD at merge time) and `head_commit`.
3. **Verify the commit chain:** Walk from `head_commit` back to `base_commit`, recomputing each commit's hash along the way.
4. **Verify the trees:** For any commit, recompute its root tree hash via Merkle verification (Section 4) to confirm file integrity.

---

## 7. Cross-Type Collision Resistance

All object types (blob, tree, commit) use a **type tag** as the first component of the hash input:

```
Blob:   SHA256( "blob"   + "\0" + ... )
Tree:   SHA256( "tree"   + "\0" + ... )
Commit: SHA256( "commit" + "\0" + ... )
PR:     SHA256( "pr"     + "\0" + ... )
```

This ensures that objects of different types **cannot collide**, even if their remaining content bytes happen to be identical. A blob hash will never equal a tree hash, a tree hash will never equal a commit hash, etc.

---

## 8. Hash Verification (Integrity Checking)

Any stored object can be verified by recomputing its hash from its content:

### 8.1 Verify a Blob
```
function verify_blob(blob):
    expected = SHA256("blob\0" + str(blob.size) + "\0" + blob.content)
    return expected == blob.blob_hash
```

### 8.2 Verify a Tree
```
function verify_tree(tree_hash):
    entries = load_tree_entries(tree_hash)
    sorted_entries = sort_by_name(entries)

    child_strings = ""
    for entry in sorted_entries:
        child_strings += entry.entry_type + " " + entry.name + "\0" + entry.object_hash

    expected = SHA256("tree\0" + child_strings)
    return expected == tree_hash
```

### 8.3 Verify a Commit
```
function verify_commit(commit):
    content = build_commit_content(commit)
    expected = SHA256("commit\0" + str(byte_length(content)) + "\0" + content)
    return expected == commit.commit_hash
```

### 8.4 Full Repository Verification

To verify the integrity of the entire repository from a single commit:

```
function verify_repository(commit_hash, visited = {}):
    if commit_hash in visited:
        return true    // already verified (handles DAG convergence)
    visited[commit_hash] = true

    // 1. Verify this commit
    commit = load_commit(commit_hash)
    ASSERT verify_commit(commit)

    // 2. Verify the root tree (recursively verifies all subtrees and blobs)
    ASSERT verify_tree_recursive(commit.root_tree)

    // 3. Verify ALL parents (walks full DAG, not just first parent)
    // Uses get_all_parents() from storage spec §5.1 to follow merge commit
    // second parents. Without this, commits reachable only via a merge
    // commit's second parent would be silently skipped.
    for parent in get_all_parents(commit_hash):
        ASSERT verify_repository(parent, visited)

    return true

function verify_tree_recursive(tree_hash):
    ASSERT verify_tree(tree_hash)

    entries = load_tree_entries(tree_hash)
    for entry in entries:
        if entry.entry_type == "blob":
            blob = load_blob(entry.object_hash)
            ASSERT verify_blob(blob)
        elif entry.entry_type == "tree":
            ASSERT verify_tree_recursive(entry.object_hash)

    return true
```

---

## 9. Key Invariants

1. **Content addressability** — Any object can be verified by recomputing its hash from its content.
2. **Blob deduplication** — Identical file content is stored exactly once, keyed by hash.
3. **Tree determinism** — Sorting child entries by name ensures the same directory always produces the same hash.
4. **Immutability** — Blobs, trees, and commits are never modified after creation. Only mutable references (repo HEAD, workspace head) change.
5. **Merkle integrity** — Changing any file in the tree changes every ancestor tree hash up to the root, making tampering detectable.
6. **Cross-type safety** — Type tags in hash inputs prevent collisions between different object types.
7. **Chain integrity** — Parent-linking in commits means verifying a single commit hash implicitly verifies the entire ancestor chain.
