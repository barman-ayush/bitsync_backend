# Commits API

Routes mounted under `/api/commit` (see `src/routes/commit.routes.ts`).
Controller: `src/controllers/commit.controller.ts`.
Validators: `src/validators/workspace.validators.ts`.

All routes in this category require authentication (`authMiddleware` is applied router-wide).
All routes verify active membership access via `requireRepoAccess` and permission checks (`repo:view` or `repo:push`).

For shared conventions, see [conventions.md](./conventions.md).

---

## `POST /api/commit/:repoId/:workspaceId`

Bake the workspace's uncommitted changes (dirty files recorded in `workspace_changes`) into a new commit, advance the workspace HEAD pointer, and clear workspace changes. The author information is automatically derived from the authenticated caller.

If the workspace is associated with an active open Pull Request, the PR HEAD is updated to point to the newly created commit.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:push")`.

### Path parameters

| Param | Rules | Description |
| --- | --- | --- |
| `repoId` | UUID | Repository ID. |
| `workspaceId` | UUID | Workspace ID (must be owned by the caller). |

### Request body

```json
{
  "message": "Add authentication middleware tests"
}
```

| Field | Rules | Description |
| --- | --- | --- |
| `message` | Required. string | Commit message detailing the changes. |

### Responses

**`201 Created`**

```json
{
  "status": "success",
  "data": {
    "commitHash": "new-commit-hash-string",
    "parent": "parent-commit-hash-string",
    "rootTree": "new-tree-hash-string",
    "author": {
      "name": "Ayush Barman",
      "email": "ayush@example.com"
    },
    "message": "Add authentication middleware tests",
    "timestamp": "2026-05-28T10:05:00.000Z",
    "parentWorkspaceId": "workspace-uuid"
  }
}
```

**Errors**
- `400 BadRequest` — validation failure, or workspace is in `CONFLICTED` state: `"Cannot commit: please resolve conflicts first."`
- `401 Unauthorized` — not authenticated.
- `404 NotFound` — workspace or repository not found.

---

## `GET /api/commit/history/:repoId/:workspaceId`

Fetch a paginated list of commits made in the specified workspace since it was fork-pointed, sorted newest first. The parent chain walks backwards.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Path parameters

| Param | Rules | Description |
| --- | --- | --- |
| `repoId` | UUID | Repository ID. |
| `workspaceId` | UUID | Workspace ID. |

### Query parameters

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `cursor` | string | — | Commit hash cursor to start paginating from. |
| `limit` | integer (1–100) | `20` | Maximum number of commits to return. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": [
    {
      "commitHash": "commit-hash-string",
      "parent": "parent-commit-hash-string",
      "rootTree": "tree-hash-string",
      "author": {
        "name": "Ayush Barman",
        "email": "ayush@example.com"
      },
      "message": "Add authentication middleware tests",
      "timestamp": "2026-05-28T10:05:00.000Z"
    }
  ],
  "pagination": {
    "nextCursor": "next-commit-hash-string",
    "hasMore": false
  }
}
```
