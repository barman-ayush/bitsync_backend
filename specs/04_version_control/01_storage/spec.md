# 01_storage — Storage Specification

## 1. Overview

BitSync uses a **content-addressed object model** inspired by Git. All objects (blobs, trees, commits) are identified by their SHA-256 hash. The system is a **single-branch** model — there is no branching on the repo itself. Users work in **workspaces** (analogous to Git branches) and merge changes back via **Pull Requests (PRs)**.

Workspaces can be **reused after merge** — they are not disposable. A workspace is the BitSync equivalent of a Git branch, with the added capability of tracking uncommitted changes (no staging area).

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
| commit_hash          | TEXT (PK)  | SHA-256 hash of the commit (see 4.3)                     |
| root_tree            | TEXT (FK)  | Hash of the root tree for this commit                     |
| parent               | TEXT (FK)  | Hash of the parent commit (`NULL` for the initial commit) |
| author               | TEXT       | Author identifier                                         |
| timestamp            | TIMESTAMP  | When the commit was created                               |
| message              | TEXT       | Commit message                                            |
| parent_workspace_id  | UUID (FK)  | Workspace this commit was created in (`NULL` = main-line commit) |

**Notes:**
- The **head_commit** of a repo points to the latest commit. Following the `parent` chain walks the full history.
- The `root_tree` of a commit is the entry point to traverse the entire file tree at that snapshot.
- Merge commits may have **multiple parents** (stored in a separate `commit_parents` table — see section 5).
- `parent_workspace_id` is **permanent provenance** — it records where the commit was originally created and is **never mutated**. It does not change when a PR is merged. To determine the main-line history, walk the `parent[0]` chain from repo HEAD.

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

**Lifecycle:** Workspaces can be reused after merge. On PR merge, `fork_point` is updated to the new repo HEAD. The user can continue making changes and open new PRs from the same workspace.

**Critical invariant:** After a PR merge, `workspace.fork_point` **must** be updated to the new repo HEAD. Failing to do so causes the next merge to use a stale base, leading to duplicate changes and false conflicts.

### 3.6 Workspace Changes (Uncommitted State)

Tracks files the user has modified but **not yet committed**. This is the equivalent of Git's dirty working directory — there is no staging area.

| Field         | Type       | Description                                              |
|--------------|------------|----------------------------------------------------------|
| id           | UUID (PK)  | Unique identifier                                         |
| workspace_id | UUID (FK)  | The workspace these changes belong to                     |
| file_path    | TEXT       | Full path of the changed file                             |
| action       | ENUM       | `ADD` / `MODIFY` / `DELETE`                               |
| blob_hash    | TEXT (FK)  | New content blob (`NULL` for DELETE)                      |

**Constraints:**
- `(workspace_id, file_path)` must be **unique** — one pending change per file path per workspace.
- On commit, all `workspace_changes` for the workspace are baked into the new commit and then **cleared**.
- For `ADD`/`MODIFY`, the blob must already exist in the `blob` table (uploaded separately).

### 3.7 Repository

| Field       | Type       | Description                                              |
|------------|------------|----------------------------------------------------------|
| id         | UUID (PK)  | Unique repo identifier                                    |
| name       | TEXT       | Repository name                                           |
| owner_id   | UUID (FK)  | The user who owns the repo                                |
| head_commit| TEXT (FK)  | Hash of the latest commit (`NULL` for empty repo)         |
| created_at | TIMESTAMP  | Creation time                                             |
| updated_at | TIMESTAMP  | Last update time                                          |

### 3.8 Pull Request

A PR is a **wrapper over a workspace** — it proposes merging the workspace's commits into the repo.

| Field          | Type       | Description                                             |
|---------------|------------|---------------------------------------------------------|
| id            | UUID (PK)  | Unique PR identifier                                     |
| repo_id       | UUID (FK)  | Target repository                                        |
| workspace_id  | UUID (FK)  | Source workspace                                         |
| author_id     | UUID (FK)  | User who created the PR                                  |
| title         | TEXT       | PR title                                                 |
| description   | TEXT       | PR description                                           |
| status        | ENUM       | `OPEN` / `APPROVED` / `CHANGES_REQUESTED` / `MERGED` / `CLOSED` |
| base_commit   | TEXT (FK)  | Snapshotted from `workspace.fork_point` **at merge time** (`NULL` while open) |
| head_commit   | TEXT (FK)  | Snapshotted from `workspace.head` **at merge time** (`NULL` while open) |
| merge_commit  | TEXT (FK)  | The resulting merge/fast-forward commit (`NULL` until merged) |
| created_at    | TIMESTAMP  | Creation time                                            |
| updated_at    | TIMESTAMP  | Last update time                                         |

**While open:** `base_commit`, `head_commit`, and `merge_commit` are all `NULL`. The PR's commit range is derived live from `workspace.fork_point` → `workspace.head`. This means new commits pushed to the workspace automatically appear in the PR.

**On merge:** `base_commit`, `head_commit`, and `merge_commit` are frozen as a permanent snapshot. The workspace can then be reused or deleted without losing PR history.

### 3.9 PR Review

| Field        | Type       | Description                                              |
|-------------|------------|----------------------------------------------------------|
| id          | UUID (PK)  | Unique review identifier                                  |
| pr_id       | UUID (FK)  | The PR being reviewed                                     |
| reviewer_id | UUID (FK)  | User who submitted the review                             |
| verdict     | ENUM       | `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`            |
| body        | TEXT       | Review comment (optional)                                 |
| created_at  | TIMESTAMP  | When the review was submitted                             |

### 3.10 PR Comment

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

> **Moved:** The full hashing specification (blob, tree, commit, and PR hashing algorithms) is now in [02_hashing/spec.md](../02_hashing/spec.md).

**Quick reference — all hashing uses SHA-256:**
- **Blob hash:** `SHA256( "blob\0" + size + "\0" + content )`
- **Tree hash:** `SHA256( "tree\0" + sorted_child_entries )` (Merkle tree)
- **Commit hash:** `SHA256( "commit\0" + byte_length + "\0" + content )`

See [02_hashing/spec.md](../02_hashing/spec.md) for the complete algorithms, examples, PR fingerprinting, and integrity verification procedures.

---

## 5. Relationships

```
User ──1:N──> Workspace
User ──1:N──> Repository (ownership)

Repository ──1:N──> Pull Request
Repository ──1:1──> Commit (head_commit, nullable)

Workspace ──N:1──> Repository
Workspace ──N:1──> User
Workspace ──1:1──> Commit (fork_point)
Workspace ──1:1──> Commit (head)
Workspace ──1:N──> Workspace Changes
Workspace ──1:N──> Pull Request

Pull Request ──1:N──> PR Review
Pull Request ──1:N──> PR Comment

Commit ──1:1──> Tree (root_tree)
Commit ──N:1──> Commit (parent, nullable)
Commit ──N:1──> Workspace (parent_workspace_id, nullable — provenance only)

Tree ──1:N──> Tree Entry
Tree Entry ──N:1──> Blob (if entry_type = blob)
Tree Entry ──N:1──> Tree (if entry_type = tree)

Workspace Changes ──N:1──> Blob (blob_hash, nullable)
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
