# Pull Requests API

Routes mounted under `/api/pr` (see `src/routes/pr.routes.ts`).
Controller: `src/controllers/pr.controller.ts`.
Validators: `src/validators/pr.validators.ts`.

All routes in this category require authentication (`authMiddleware` is applied router-wide).
All routes that operate on a specific repository verify active membership access via `requireRepoAccess` and permission checks (`repo:view` or `repo:push`).

For shared conventions, see [conventions.md](./conventions.md).

---

## `GET /api/pr/commit-trail/:repoId/:workspaceId{/:prId}`

Fetch the commit trail (commits present in the workspace/PR but not in the main repository HEAD), sorted by timestamp ascending. Used to review commits associated with a PR. The `:prId` parameter is optional (helps fetch draft trail before PR creation).

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Path parameters

| Param | Rules | Description |
| --- | --- | --- |
| `repoId` | UUID | Repository ID. |
| `workspaceId` | UUID | Workspace ID. |
| `prId` | UUID | Optional. Pull Request ID. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": [
    {
      "message": "Add authentication middleware tests",
      "commitHash": "commit-hash-sha",
      "timestamp": "2026-05-28T10:05:00.000Z"
    }
  ]
}
```

---

## `GET /api/pr/status/:repoId/:workspaceId`

Fetch the Pull Request action status for a workspace. Determines whether the user should be prompted to create a new PR (`CREATE_PR`) or view the existing open PR associated with the workspace (`VIEW_PR`).

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Path parameters

| Param | Rules | Description |
| --- | --- | --- |
| `repoId` | UUID | Repository ID. |
| `workspaceId` | UUID | Workspace ID. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "status": "CREATE_PR"
  }
}
```

---

## `POST /api/pr/create/:repoId/:workspaceId`

Create a new Pull Request for the workspace's commits to be merged into the main repository.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:push")`.

### Request body

```json
{
  "title": "Implement JWT rotation",
  "description": "Adds token rotation logic on access token expiry.",
  "reviewers": ["reviewer1@example.com", "reviewer2@example.com"]
}
```

| Field | Rules | Description |
| --- | --- | --- |
| `title` | Required. string | Title of the Pull Request. |
| `description` | Required. string | Description detailing changes. |
| `reviewers` | Optional array of emails | User email addresses to invite as reviewers. |

### Responses

**`201 Created`**

```json
{
  "status": "success",
  "data": {
    "id": "pr-uuid",
    "repoId": "repo-uuid",
    "workspaceId": "workspace-uuid",
    "authorId": "author-uuid",
    "title": "Implement JWT rotation",
    "description": "Adds token rotation logic on access token expiry.",
    "status": "OPEN",
    "baseCommit": "base-commit-hash",
    "prHead": "pr-head-commit-hash",
    "createdAt": "2026-05-28T10:10:00.000Z",
    "updatedAt": "2026-05-28T10:10:00.000Z"
  }
}
```

---

## `GET /api/pr/mergeability/:repoId/:workspaceId/:prId`

Perform a dry-run three-way merge to check if the PR can be merged cleanly into repository HEAD without conflicts. Returns the list of conflict counts.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "mergeable": true,
    "conflictsCount": 0
  }
}
```

---

## `GET /api/pr/list/:repoId`

List all Pull Requests for a repository. Supports pagination and searching.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Query parameters

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `cursor` | UUID | — | Pull Request ID cursor to start pagination. |
| `limit` | integer (1–100) | `20` | Maximum items to return. |
| `q` | string | — | Text search query over title and description. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": [
    {
      "id": "pr-uuid",
      "title": "Implement JWT rotation",
      "status": "OPEN",
      "authorId": "author-uuid",
      "createdAt": "2026-05-28T10:10:00.000Z",
      "updatedAt": "2026-05-28T10:10:00.000Z"
    }
  ],
  "pagination": {
    "nextCursor": "pr-uuid-2",
    "hasMore": false
  }
}
```

---

## `GET /api/pr/details/:repoId/:prId`

Fetch full metadata details of a single Pull Request, including the author user profile and assigned reviewers.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "id": "pr-uuid",
    "title": "Implement JWT rotation",
    "description": "...",
    "status": "OPEN",
    "baseCommit": "hash",
    "prHead": "hash",
    "author": {
      "id": "uuid",
      "displayName": "Ayush Barman",
      "username": "ayush",
      "avatarUrl": null
    },
    "reviewers": [
      {
        "id": "reviewer-uuid",
        "displayName": "Reviewer User",
        "username": "reviewer",
        "verdict": "APPROVED"
      }
    ]
  }
}
```

---

## `GET /api/pr/commit-changes/:repoId/:workspaceId`

Fetch a list of file changes between the workspace HEAD and the latest merge point of the repository.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": [
    {
      "filePath": "src/app.ts",
      "type": "MODIFY",
      "oldBlobHash": "sha-old-hash",
      "newBlobHash": "sha-new-hash"
    }
  ]
}
```

---

## `POST /api/pr/close/:repoId/:prId`

Close an open Pull Request without merging.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Pull Request closed successfully."
}
```

---

## `GET /api/pr/assigned-reviews/:repoId`

Retrieve all Pull Request reviews assigned to the currently authenticated user in a repository.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Query parameters

| Param | Type | Description |
| --- | --- | --- |
| `cursor` | UUID | Optional ID cursor. |
| `limit` | integer | Optional limit (1-100, default 20). |
| `q` | string | Optional text search. |
| `verdict` | `APPROVED` \| `CHANGES_REQUESTED` \| `PENDING` | Optional verdict filter. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": [
    {
      "id": "review-uuid",
      "prId": "pr-uuid",
      "verdict": "PENDING",
      "pullRequest": {
        "title": "Implement JWT rotation",
        "status": "OPEN"
      }
    }
  ]
}
```

---

## `GET /api/pr/review-view/:repoId/:workspaceId/:prId`

Fetch workspace changes tree files and metadata for the reviewer UI.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "changes": [
      {
        "filePath": "src/app.ts",
        "type": "MODIFY",
        "oldBlobHash": "sha-old",
        "newBlobHash": "sha-new"
      }
    ]
  }
}
```

---

## `GET /api/pr/changes-view/:repoId/:workspaceId/:prId`

Fetch all PR changes and unresolved merge conflicts. Used in the merge conflict resolution view.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "changes": [
      {
        "filePath": "src/app.ts",
        "type": "MODIFY"
      }
    ],
    "conflicts": [
      {
        "id": "conflict-uuid",
        "filePath": "src/app.ts",
        "conflictType": "EDIT_EDIT",
        "baseBlob": "hash-base",
        "oursBlob": "hash-ours",
        "theirsBlob": "hash-theirs",
        "resolution": "PENDING"
      }
    ],
    "mergeStateId": "merge-state-uuid"
  }
}
```

---

## `GET /api/pr/reviews/:repoId/:prId`

List reviews submitted on a Pull Request.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": [
    {
      "id": "review-uuid",
      "verdict": "APPROVED",
      "body": "Looks solid!",
      "createdAt": "2026-05-28T12:00:00.000Z",
      "user": {
        "displayName": "Reviewer Name",
        "username": "reviewer"
      }
    }
  ]
}
```

---

## `POST /api/pr/resolve-conflicts/:repoId/:prId`

Submit resolution choices for conflicted files in a three-way merge.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:push")`.

### Request body

```json
{
  "resolutions": [
    { "conflictId": "conflict-uuid-1", "resolution": "TAKE_OURS" },
    { "conflictId": "conflict-uuid-2", "resolution": "TAKE_THEIRS" },
    { "conflictId": "conflict-uuid-3", "resolution": "MANUAL", "resolvedBlob": "resolved-blob-hash-sha" }
  ]
}
```

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Conflicts resolved successfully."
}
```

---

## `POST /api/pr/merge/:repoId/:prId`

Merge the Pull Request into repository main HEAD. The merge advances the HEAD commit pointer and updates status to `MERGED`.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:push")`.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Pull Request merged successfully."
}
```

**Errors**
- `400 BadRequest` — conflicts exist and must be resolved before merging.

---

## `POST /api/pr/add-reviewers/:repoId/:prId`

Add reviewers to a Pull Request.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:push")`.

### Request body

```json
{
  "reviewerIds": ["reviewer-user-uuid-1", "reviewer-user-uuid-2"]
}
```

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Reviewers added successfully."
}
```

---

## `POST /api/pr/submit-review/:repoId/:prId`

Submit a review response (approve or request changes) on a Pull Request.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Request body

```json
{
  "verdict": "APPROVED",
  "body": "Good work, looks ready."
}
```

| Field | Rules | Description |
| --- | --- | --- |
| `verdict` | Required. `"APPROVED"` or `"CHANGES_REQUESTED"` | Review outcome. |
| `body` | Optional. string | Explanation or review feedback text. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Review submitted successfully."
}
```

---

## `GET /api/pr/review-status/:repoId/:prId`

Get PR approval status review counters (e.g. number of approvals, changes requested, and pending reviews).

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "approvals": 2,
    "changesRequested": 0,
    "pending": 0
  }
}
```

---

## `POST /api/pr/comment/:repoId/:prId`

Add a comment to a Pull Request thread. Supports general thread comments and file-line specific review comments.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Request body

```json
{
  "body": "Consider refactoring this to use a helper function.",
  "filePath": "src/app.ts"
}
```

| Field | Rules | Description |
| --- | --- | --- |
| `body` | Required. string | Comment text. |
| `filePath` | Optional. string | Relates comment to a specific file. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "id": "comment-uuid",
    "body": "Consider refactoring this to use a helper function.",
    "filePath": "src/app.ts",
    "createdAt": "2026-05-28T12:30:00.000Z"
  }
}
```

---

## `DELETE /api/pr/comment/:repoId/:prId/:commentId`

Delete a review comment. Caller must be the author of the comment or admin.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Path parameters

| Param | Rules | Description |
| --- | --- | --- |
| `repoId` | UUID | Repository ID. |
| `prId` | UUID | Pull Request ID. |
| `commentId` | UUID | Comment ID. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Comment deleted successfully."
}
```
