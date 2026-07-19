# 03_commit — Commit Specifications

This specification details how BitSync fetches directory trees and generates new commits from personal workspace modifications.

## 1. Directory Tree Resolution

To efficiently display files and folders in the user interface, BitSync supports two methods of directory tree resolution:

### 1.1 Lazy-Loaded Committed Trees
Directories are fetched one level at a time. The server queries the `tree_entry` table for a specific `tree_hash` to list immediate child items (files and subfolders). File sizes are resolved in the same query via a left join with the `blob` table to avoid N+1 query overhead. Subdirectories are resolved only when expanded by the client.

### 1.2 Workspace Tree Resolution (Committed + Uncommitted Overlay)
When displaying a workspace's current state, the server overlays the committed tree entries with the user's uncommitted modifications recorded in `workspace_changes`.
- **Additions (`ADD`)**: Inserts newly added uncommitted files or virtual subdirectories.
- **Modifications (`MODIFY`)**: Overwrites the hash and size of committed files with the uncommitted blob parameters.
- **Deletions (`DELETE`)**: Hides or filters out committed entries from the returned list.

---

## 2. Commit Creation & Merkle Tree Rebuilding

When a user commits uncommitted changes from their workspace, the server bakes these changes into a new commit. The commit creation performs the following operations:

1. **Verify State**: Confirms the workspace exists, is owned by the caller, and is not in a `CONFLICTED` merge state.
2. **Rebuild the Merkle Tree**: Computes the new root tree hash by rebuilding only the modified paths:
   - Walk down the paths of all modified files.
   - For any subdirectory that has no changes in its descendant path, reuse its existing `tree_hash` directly (referencing the unchanged subtree in the database without creating new rows).
   - Recompute tree hashes upward from modified files to the root, generating new `tree` and `tree_entry` records for modified subdirectories only.
3. **Persist Commit**:
   - Saves a new `Commit` record with the newly generated root tree hash, author credentials, current timestamp (in Indian Standard Time), and commit message.
   - Adds parent commit linkages.
4. **Advance HEAD**:
   - Updates the workspace's current head pointer to the new commit hash using a compare-and-swap update to guarantee concurrent transaction safety (optimistic locking).
   - Clears the processed uncommitted records from the workspace changes store.
5. **Update PRs**: If the workspace is bound to an open Pull Request, updates the PR HEAD pointer to the new commit hash.
