# 01_storage — Storage Specification

This specification details the core object storage model and relationships in BitSync.

## 1. Overview

BitSync uses a content-addressed object model inspired by Git. All version-controlled data — files, directories, and commits — is stored in an immutable, content-addressed format. The system follows a single-branch model (without main-line branching). Users fork personal workspaces to make changes and submit Pull Requests to merge them back into the repository main line.

---

## 2. Core Entities

- **Repository**: The top-level version-controlled project container. Contains a pointer to the current `headCommit` on the main line.
- **Workspace**: A user's personal working copy of a repository. It tracks a `forkPoint` commit, a `head` commit, and any uncommitted workspace changes.
- **Blob**: Stores raw binary content of a file. Keyed by a SHA-256 hash computed over its content. Blobs are immutable and automatically deduplicated.
- **Tree**: Represents a directory. Consists of a unique hash identifier.
- **Tree Entry**: Links a directory (Tree) to its children. A child can be a file (Blob) or a subdirectory (Tree).
- **Commit**: A snapshot of the entire repository directory hierarchy at a point in time, referenced by a root Tree hash. It contains author details, a timestamp, and parent commit links.
- **Workspace Change**: Records uncommitted modifications (`ADD`, `MODIFY`, or `DELETE` actions) relative to the workspace's current HEAD.
- **Merge State**: Tracks an in-progress three-way merge operation during PR review/resolution.
- **Merge Conflict**: Records file-level conflicts discovered during a merge.

---

## 3. Relationships & Graph Utilities

### 3.1 Commit Parents (Join Table)
To represent merge commits that contain multiple parents, BitSync stores parent listings in a join table linking a merge commit hash to parent hashes with an ordinal sequence (0-based order).

### 3.2 Graph Traversal
Traversing history and finding divergence points uses the commit directed acyclic graph (DAG) structure:

- **Parent Resolution**: Walks back from a commit. For merge commits, it retrieves all parent hashes in sequence from the parent ordinals, falling back to a single parent column for standard commits.
- **Merge Base Identification**: Finds the most recent common ancestor of two commits by executing a parallel breadth-first search (BFS) starting from both commit nodes. It traverses all parents (including merge parents), terminating at the first intersection point.
- **Ancestor Evaluation**: Determines if a commit is reachable from a descendant node by recursively walking back through all parents in the DAG.

---

## 4. Key Invariants

1. **Content Addressability**: All database entries for files, directories, and commits can be cryptographically verified by hashing their content.
2. **Deduplication**: Identical file bytes are stored exactly once globally as a unique blob hash.
3. **Determinism**: Sorting tree child entries alphabetically ensures identical directory states produce identical hashes.
4. **Immutability**: Stored objects are never modified. System progress advances by updating mutable references (e.g. repository head commit, workspace head).
5. **Indian Standard Time (IST)**: All timezone-aware timestamps are stored and normalized in Indian Standard Time (UTC+5:30).
