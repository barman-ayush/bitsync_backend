# 01_storage — Storage Specification

## 1. Overview

BitSync uses a **content-addressed object model** inspired by Git. All objects (blobs, trees, commits) are identified by their SHA-256 hash. The system is a **single-branch** model — there is no branching on the repo itself. Users work in **workspaces** (analogous to local clones) and merge changes back via **Pull Requests (PRs)**.

---

## 2. Core Concepts

### 2.1 Repository

A repository is the top-level entity. Each repo has:

- A **head_commit** — points to the latest commit on the single main branch. `NULL` when the repo is first created (empty repo).
- A set of **PRs** associated with it.
- A set of **workspaces** created from it.

### 2.2 Workspace

A workspace is a user's working copy of a repo.

- **Always forked from the current HEAD** at the time of creation. The workspace receives the full commit chain from the first commit up to HEAD. You cannot create a workspace from an arbitrary older commit.
- Contains **local changes** that are not yet committed / merged into the repo.
- One user can have **many workspaces** for the same repo.
- There is **no staging area** — the user works directly in the workspace, creates commits, then opens a PR to merge into the main repo.

**Example:**
```
Repo:  A → B → C → D (HEAD)

User creates workspace → workspace gets: A → B → C → D (fork_point = D)
                         NOT allowed:     fork from B
```

### 2.3 Workflow

```
1. User creates a workspace (snapshot from repo HEAD)
2. User makes changes in the workspace
3. User creates commits in the workspace
4. User opens a PR to merge workspace commits into the repo
5. PR is reviewed, approved, and merged — repo HEAD advances
```

---

## 3. Object Model

### 3.1 Blob

A blob stores the **raw content of a file**. Blobs are **immutable** and **content-addressed** — two files with identical content always produce the same blob, regardless of filename or file type.

| Field        | Type     | Description                          |
|-------------|----------|--------------------------------------|
| blob_hash   | TEXT (PK)| SHA-256 hash of the blob (see 4.1)   |
| size        | BIGINT   | Size of the content in bytes          |
| content     | BYTEA    | Raw file content                      |

**Constraints:**
- Two blobs **cannot** have the same `blob_hash` (primary key).
- Blobs with the same hash are **guaranteed** to have the same content.
- Blobs are **never modified** — only created and (eventually) garbage collected.

### 3.2 Tree

A tree represents a **directory/folder**. It does not directly contain file data — instead, it references its children through **tree entries**.

| Field      | Type     | Description                                |
|-----------|----------|--------------------------------------------|
| tree_hash | TEXT (PK)| SHA-256 hash of the tree (see 4.2)          |

A tree's identity is fully determined by its children (via Merkle hashing). Two directories with identical contents at every level produce the same tree hash.

### 3.3 Tree Entry

A tree entry represents a **single entry within a directory** — either a file (blob) or a subdirectory (tree).

| Field         | Type     | Description                                          |
|--------------|----------|------------------------------------------------------|
| id           | UUID (PK)| Unique identifier for this entry                      |
| parent_tree  | TEXT (FK)| Hash of the tree this entry belongs to                |
| entry_type   | ENUM     | `blob` or `tree`                                      |
| name         | TEXT     | Name of the file or subdirectory                      |
| object_hash  | TEXT     | Hash of the referenced blob or tree                   |

**Constraints:**
- `(parent_tree, name)` must be **unique** — no two entries in the same tree can have the same name.
- `entry_type` determines whether `object_hash` references the `blob` table or the `tree` table.

### 3.4 Commit

A commit is a **snapshot** of the entire repo at a point in time. The head commit's root tree gives access to the full file/folder structure.

| Field       | Type       | Description                                              |
|------------|------------|----------------------------------------------------------|
| commit_hash| TEXT (PK)  | SHA-256 hash of the commit (see 4.3)                     |
| root_tree  | TEXT (FK)  | Hash of the root tree for this commit                     |
| parent     | TEXT (FK)  | Hash of the parent commit (`NULL` for the initial commit) |
| author     | TEXT       | Author identifier                                         |
| timestamp  | TIMESTAMP  | When the commit was created                               |
| message    | TEXT       | Commit message                                            |

**Notes:**
- The **head_commit** of a repo points to the latest commit. Following the `parent` chain walks the full history.
- The `root_tree` of a commit is the entry point to traverse the entire file tree at that snapshot.
- Merge commits may have **multiple parents** (stored in a separate `commit_parents` table — see section 5).

### 3.5 Workspace

| Field       | Type       | Description                                              |
|------------|------------|----------------------------------------------------------|
| id         | UUID (PK)  | Unique workspace identifier                               |
| repo_id    | UUID (FK)  | The repository this workspace belongs to                  |
| user_id    | UUID (FK)  | The user who owns this workspace                          |
| name       | TEXT       | Human-readable workspace name                             |
| fork_point | TEXT (FK)  | Commit hash the workspace was forked from                 |
| head       | TEXT (FK)  | Current tip commit in this workspace                      |
| status     | ENUM       | `CLEAN` / `MERGING` / `CONFLICTED`                        |
| created_at | TIMESTAMP  | Creation time                                             |
| updated_at | TIMESTAMP  | Last update time                                          |

### 3.6 Repository

| Field       | Type       | Description                                              |
|------------|------------|----------------------------------------------------------|
| id         | UUID (PK)  | Unique repo identifier                                    |
| name       | TEXT       | Repository name                                           |
| owner_id   | UUID (FK)  | The user who owns the repo                                |
| head_commit| TEXT (FK)  | Hash of the latest commit (`NULL` for empty repo)         |
| created_at | TIMESTAMP  | Creation time                                             |
| updated_at | TIMESTAMP  | Last update time                                          |

### 3.7 Pull Request

| Field          | Type       | Description                                             |
|---------------|------------|---------------------------------------------------------|
| id            | UUID (PK)  | Unique PR identifier                                     |
| repo_id       | UUID (FK)  | Target repository                                        |
| workspace_id  | UUID (FK)  | Source workspace                                         |
| author_id     | UUID (FK)  | User who created the PR                                  |
| title         | TEXT       | PR title                                                 |
| description   | TEXT       | PR description                                           |
| status        | ENUM       | `OPEN` / `APPROVED` / `CHANGES_REQUESTED` / `MERGED` / `CLOSED` |
| base_commit   | TEXT (FK)  | Repo HEAD at the time the PR was created                 |
| head_commit   | TEXT (FK)  | Workspace HEAD at the time the PR was created            |
| created_at    | TIMESTAMP  | Creation time                                            |
| updated_at    | TIMESTAMP  | Last update time                                         |

### 3.8 PR Review

| Field        | Type       | Description                                              |
|-------------|------------|----------------------------------------------------------|
| id          | UUID (PK)  | Unique review identifier                                  |
| pr_id       | UUID (FK)  | The PR being reviewed                                     |
| reviewer_id | UUID (FK)  | User who submitted the review                             |
| verdict     | ENUM       | `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`            |
| body        | TEXT       | Review comment (optional)                                 |
| created_at  | TIMESTAMP  | When the review was submitted                             |

### 3.9 PR Comment

| Field        | Type       | Description                                              |
|-------------|------------|----------------------------------------------------------|
| id          | UUID (PK)  | Unique comment identifier                                 |
| pr_id       | UUID (FK)  | The PR this comment belongs to                            |
| author_id   | UUID (FK)  | User who wrote the comment                                |
| body        | TEXT       | Comment content                                           |
| file_path   | TEXT       | File path the comment is on (`NULL` for general comments) |
| line_number | INT        | Line number in the file (`NULL` for general comments)     |
| created_at  | TIMESTAMP  | Creation time                                             |
| updated_at  | TIMESTAMP  | Last update time                                          |

---

## 4. Hashing

All hashing uses **SHA-256**. The hashing scheme is designed so that:
- Identical content always produces the same hash.
- Any change, no matter how small, produces a completely different hash.
- Tree hashes are computed as a **Merkle tree** — a change in any descendant file propagates up to the root.

### 4.1 Blob Hash

Blobs are hashed using their type tag, size, and raw content:

```
HASH = SHA256( "blob" + "\0" + size + "\0" + file_content_in_bytes )
```

- `size` is the byte length of `file_content_in_bytes`, as a decimal string.
- Two files with identical byte content produce the same blob hash, regardless of filename or path.
- This matches Git's blob hashing scheme (with SHA-256 instead of SHA-1).

**Example:**
```
File content: "hello world" (11 bytes)
Input to hash: "blob\011\0hello world"
```

### 4.2 Tree Hash (Merkle Tree)

Trees are hashed using their children's types, names, and hashes — producing a **Merkle hash**:

**Step 1:** For each child entry, create a string:
```
"<type> <name>\0<object_hash>"
```
Where `type` is either `blob` or `tree`.

**Step 2:** Sort all child strings by **name** (lexicographic, for determinism).

**Step 3:** Concatenate the sorted strings.

**Step 4:** Hash:
```
HASH = SHA256( "tree\0" + concatenated_sorted_child_strings )
```

**Properties:**
- Renaming a file changes the tree hash (name is part of the input).
- Changing file content changes the blob hash, which changes the tree hash, which propagates up to the root.
- Two directories with identical structure and content produce the same tree hash.

**Example:**
```
Directory contains:
  README.md  (blob, hash=abc123...)
  src/       (tree, hash=def456...)

Sorted child strings:
  "blob README.md\0abc123..."
  "tree src\0def456..."

Input to hash: "tree\0blob README.md\0abc123...tree src\0def456..."
```

### 4.3 Commit Hash

Commits are hashed using Git's format — the hash is computed over a structured header string:

**Step 1:** Build the commit content string:
```
tree <root_tree_hash>\n
parent <parent_hash>\n          ← one line per parent; omitted for the initial commit
author <name> <email> <unix_timestamp> <timezone>\n
committer <name> <email> <unix_timestamp> <timezone>\n
\n
<message>
```

**Step 2:** Hash with a type+size header (same pattern as blobs):
```
HASH = SHA256( "commit" + "\0" + byte_length(content) + "\0" + content )
```

- For the initial commit, the `parent` line is omitted entirely.
- For merge commits, there are **multiple `parent` lines**, one per parent, in order.
- `unix_timestamp` is seconds since epoch; `timezone` is e.g., `+0530`, `+0000`.

**Example (normal commit):**
```
tree 8a7f2b...
parent 3c9d1e...
author Ayush <ayush@example.com> 1743264000 +0530
committer Ayush <ayush@example.com> 1743264000 +0530

fix: resolve workspace sync issue
```

---

## 5. Relationships

```
User ──1:N──> Workspace
User ──1:N──> Repository (ownership)

Repository ──1:N──> Pull Request
Repository ──1:1──> Commit (head_commit, nullable)

Workspace ──N:1──> Repository
Workspace ──N:1──> User
Workspace ──1:1──> Commit (fork_point = HEAD at creation time)
Workspace ──1:1──> Commit (head)
Workspace ──1:N──> Pull Request

Pull Request ──1:N──> PR Review
Pull Request ──1:N──> PR Comment

Commit ──1:1──> Tree (root_tree)
Commit ──N:1──> Commit (parent, nullable)

Tree ──1:N──> Tree Entry
Tree Entry ──N:1──> Blob (if entry_type = blob)
Tree Entry ──N:1──> Tree (if entry_type = tree)
```

### Commit Parents (for merge commits)

For merge commits that have multiple parents, a separate join table is used:

| Field        | Type     | Description                    |
|-------------|----------|--------------------------------|
| commit_hash | TEXT (FK)| The merge commit               |
| parent_hash | TEXT (FK)| A parent of the merge commit   |
| ordinal     | INT      | Order of the parent (0-based)  |

**Constraint:** `(commit_hash, ordinal)` is unique.

---

## 6. Key Invariants

1. **Content addressability** — Any object can be verified by recomputing its hash from its content.
2. **Blob deduplication** — Identical file content is stored exactly once.
3. **Tree determinism** — Sorting child entries by name ensures the same directory always produces the same hash.
4. **Immutability** — Blobs, trees, and commits are never modified after creation. Only references (head_commit, workspace head) change.
5. **Merkle integrity** — Changing any file in the tree changes every ancestor tree hash up to the root, making tampering detectable.
6. **Single branch** — The repo has one linear history (with merge commits). Branching happens only in workspaces.
