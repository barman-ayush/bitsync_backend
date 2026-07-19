# 05_merge_algorithm — Merge Conflict Algorithm

This specification details the merge conflict detection and resolution algorithm in BitSync.

## 1. Overview

Merge conflicts arise when a Pull Request is merged, and the workspace HEAD has diverged from the repository HEAD. Both history chains have evolved since their common ancestor (`merge_base`).

The algorithm performs a three-way merge to integrate changes:
- **Fast-Forward**: If the repository HEAD commit is an ancestor of the PR HEAD, the repository HEAD pointer simply advances to the PR HEAD. No merge commit is needed.
- **Three-Way Merge**: If the history has diverged, the system loads the trees for the common ancestor (`BASE`), the repository HEAD (`OURS`), and the PR HEAD (`THEIRS`) to evaluate conflicts.

---

## 2. Data Model

Merge states are recorded in the database:

### 2.1 Merge State
- `id` (UUID, Primary Key)
- `prId` (UUID, Foreign Key referencing Pull Requests)
- `workspaceId` (UUID, Foreign Key referencing Workspaces)
- `baseCommit`, `oursCommit`, `theirsCommit` (commit hash strings)
- `status` (enum: `'IN_PROGRESS'`, `'RESOLVED'`, `'ABORTED'`)
- `mergedTree` (tree hash string, nullable, stores the auto-merged root tree)

### 2.2 Merge Conflict
- `id` (UUID, Primary Key)
- `mergeStateId` (UUID, Foreign Key referencing Merge State)
- `filePath` (string)
- `conflictType` (enum: `'EDIT_EDIT'`, `'DELETE_EDIT'`, `'ADD_ADD'`, `'DIR_FILE'`)
- `baseBlob`, `oursBlob`, `theirsBlob` (blob hash strings, nullable)
- `resolvedBlob` (blob hash string, nullable)
- `resolution` (enum: `'PENDING'`, `'TAKE_OURS'`, `'TAKE_THEIRS'`, `'MANUAL'`)
- `resolvedAt` (timestamp with timezone, nullable)

---

## 3. Tree-Level Three-Way Merge Decision Table

The algorithm compares the file paths across `BASE`, `OURS`, and `THEIRS` trees and decides the outcome per file:

| OURS Change | THEIRS Change | Conflict? | Resolution |
| --- | --- | --- | --- |
| UNCHANGED | UNCHANGED | No | Keep `BASE` version |
| MODIFIED | UNCHANGED | No | Keep `OURS` version |
| UNCHANGED | MODIFIED | No | Keep `THEIRS` version |
| DELETED | UNCHANGED | No | Delete file (no-op) |
| UNCHANGED | DELETED | No | Delete file (no-op) |
| ADDED | ADDED (same hash) | No | Keep either version |
| ADDED | ADDED (different hash) | **Yes** | **ADD_ADD Conflict** |
| MODIFIED | MODIFIED (same hash) | No | Keep either version |
| MODIFIED | MODIFIED (different hash) | **Yes** | **EDIT_EDIT Conflict** (see note) |
| DELETED | MODIFIED | **Yes** | **DELETE_EDIT Conflict** |
| MODIFIED | DELETED | **Yes** | **DELETE_EDIT Conflict** |

> Note: For `EDIT_EDIT` conflicts in text files, line-level three-way merge can auto-resolve changes if they do not overlap (see `content_merge/spec.md`). If they overlap, or if it is a binary file, it triggers a manual conflict.

---

## 4. Merge Orchestration

- **Dry-Run Conflict Check**: Previews the merge status of a PR. Computes `merge_base` and runs the three-way tree merge. If conflicts are found, they are reported, but no state is persisted in the database.
- **Merge Initiation**: If diverged changes are clean, it creates the merge commit immediately. If conflicts are found, it inserts a `MergeState` and a series of `MergeConflict` rows into the database, marking the workspace as `CONFLICTED`.
- **Conflict Resolution**: The user resolves conflicts at the whole-file level by choosing `TAKE_OURS`, `TAKE_THEIRS`, or uploading a `MANUAL` resolved blob.
- **Merge Finalization**: Once all conflicts are resolved, the system builds the merged Merkle tree, creates a merge commit referencing both parents (the repo HEAD and the PR HEAD), advances repository HEAD, and marks the PR as merged.

---

## 5. Edge Cases

- **Concurrent Merges**: Checks repository HEAD state using optimistic locking during finalize. If the HEAD advanced concurrently, the merge is aborted, and the user must re-evaluate changes against the updated HEAD.
- **Directory/File Conflicts (`DIR_FILE`)**: Arises when one side replaces a folder with a file, or vice versa. This is resolved by keeping either the directory structure or the file.
