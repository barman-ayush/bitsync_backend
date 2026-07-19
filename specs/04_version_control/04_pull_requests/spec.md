# 04_pull_requests — Pull Request Specification

This specification details the lifecycle, states, and operations of Pull Requests (PRs) in BitSync.

## 1. Overview

A Pull Request is a request to merge the commits of a user's workspace into the repository's main line. It represents a staging area for review, collaboration, and merge checks. In BitSync:
- A workspace can only have **one open PR** at a time.
- Commits are pushed to the workspace, and the PR's head pointer is advanced to track workspace HEAD updates.
- Reviews and comments can be submitted on the PR.
- Merging is allowed when the PR has no merge conflicts.

---

## 2. Data Model

PRs are represented by the `pull_requests` schema containing:
- `id` (UUID, Primary key)
- `repoId` (UUID, Foreign key referencing Repositories)
- `workspaceId` (UUID, Foreign key referencing Workspaces)
- `authorId` (UUID, Foreign key referencing Users)
- `title` & `description` (strings)
- `status` (enum: `'OPEN'`, `'MERGED'`, `'CLOSED'`)
- `baseCommit` (string, the common ancestor hash at creation/merge)
- `prHead` (string, references the head commit hash of the PR)
- `createdAt` & `updatedAt` (timestamps with timezone)

---

## 3. PR Lifecycle (State Machine)

A Pull Request transitions between three main states:

- **`OPEN`**: Active state for review and updates.
  - Can transition to `CLOSED` (cancelled without merging).
  - Can transition to `MERGED` (integrated into the repository main line).
- **`CLOSED`**: Inactive state. Closed PRs can be reopened back to `OPEN`.
- **`MERGED`**: Terminal state. Once merged, the PR cannot be reopened or edited.

---

## 4. PR Core Operations

- **Creation**: Validates that no open PR exists for the workspace, that there are new commits in the workspace relative to repository HEAD, and initializes base and head pointers. Triggers notifications to repository reviewers.
- **Reviewer Management**: Allows assigning other repository contributors as reviewers.
- **Reviews & Feedback**: Reviewers can submit approval or change requests (with optional feedback comments) on the PR.
- **Status Progression**: New commits pushed to the workspace advance the PR head.
- **Closure**: Closes the PR without merging. The workspace remains active, allowing users to continue committing or open a new PR later.
- **Merging**: Executes the merge algorithm (fast-forward or three-way merge). On success, advances the repository HEAD, marks the PR as merged, and updates status values.

---

## 5. Edge Cases

- **Uncommitted Changes**: Merging is blocked if there are uncommitted files in the target workspace.
- **Empty Commits**: PR creation is blocked if there are no new commits beyond the common ancestor.
- **Concurrent Merges**: If two PRs are merged concurrently, optimistic locking checks verify repository HEAD integrity. The second merge transaction is aborted and must be retried with the updated HEAD.
