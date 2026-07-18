# Workspaces API

Routes mounted under `/api/workspace` (see `src/routes/workspace.routes.ts`).
Controller: `src/controllers/workspace.controller.ts`.
Validators: `src/validators/workspace.validators.ts`.

All routes in this category require authentication (`authMiddleware` is applied router-wide).
All routes that operate on a specific repository verify active membership access via `requireRepoAccess` and `authorize("repo:view")` or `authorize("repo:push")`.

For shared conventions, see [conventions.md](./conventions.md).

---

## `POST /api/workspace/create/:repoId/:name`

Create a new personal workspace within a repository. The workspace is initialized at the HEAD commit of the repository.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Path parameters

| Param | Rules | Description |
| --- | --- | --- |
| `repoId` | UUID | Repository ID. |
| `name` | string | Workspace name (1–255 chars, alphanumeric/hyphens/underscores). |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "id": "workspace-uuid",
    "repoId": "repo-uuid",
    "userId": "caller-user-uuid",
    "name": "my-feature-branch",
    "forkPoint": "commit-hash",
    "head": "commit-hash",
    "status": "CLEAN",
    "createdAt": "2026-05-28T10:00:00.000Z",
    "updatedAt": "2026-05-28T10:00:00.000Z"
  }
}
```

**Errors**
- `400 BadRequest` — validation failure.
- `401 Unauthorized` — not authenticated.
- `404 NotFound` — repository not found or deleted.

---

## `GET /api/workspace/get-all/:repoId`

List workspaces owned by the caller in the specified repository. Supports pagination.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Path parameters

| Param | Rules | Description |
| --- | --- | --- |
| `repoId` | UUID | Repository ID. |

### Query parameters

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `cursor` | UUID | — | Pagination cursor (workspace ID). |
| `limit` | integer (1–100) | `20` | Number of items to return. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": [
    {
      "id": "workspace-uuid",
      "repoId": "repo-uuid",
      "userId": "caller-user-uuid",
      "name": "my-feature-branch",
      "forkPoint": "commit-hash",
      "head": "commit-hash",
      "status": "CLEAN",
      "createdAt": "2026-05-28T10:00:00.000Z",
      "updatedAt": "2026-05-28T10:00:00.000Z"
    }
  ],
  "pagination": {
    "nextCursor": "workspace-uuid",
    "hasMore": false
  }
}
```

---

## `GET /api/workspace/check/:repoId/:workspaceName`

Check whether a workspace name is available under the caller's account in a given repository. Workspace names are unique per `(repository, owner)`.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Path parameters

| Param | Rules | Description |
| --- | --- | --- |
| `repoId` | UUID | Repository ID. |
| `workspaceName` | string | Workspace name to check. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "available": true
  }
}
```

---

## `GET /api/workspace/status/:repoId/:workspaceId`

Check if the workspace has any uncommitted changes pending. Returns `DIRTY` if there are pending uncommitted files, or `CLEAN` otherwise.

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
    "status": "DIRTY"
  }
}
```

---

## `GET /api/workspace/tree/get/:repoId/:workspaceId`

Fetch a directory level view of the workspace tree. It overlays the current HEAD tree entries with any uncommitted changes.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Query parameters

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | `""` (root) | Relative directory path inside workspace. |
| `tree_hash` | string | — | Explicit committed tree hash to load (alternative to path). |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": [
    {
      "name": "src",
      "type": "tree",
      "objectHash": "tree-hash-uuid",
      "action": "UNCHANGED"
    },
    {
      "name": "new-file.txt",
      "type": "blob",
      "objectHash": "blob-hash-sha",
      "size": 512,
      "action": "ADD"
    }
  ]
}
```

> Action statuses: `ADD` (new uncommitted file), `MODIFY` (updated uncommitted file), `DELETE` (deleted uncommitted file), or `UNCHANGED` (committed HEAD file).

---

## `POST /api/workspace/blob/:repoId`

Upload raw file content to store it as a content-addressed blob. The payload is sent as raw bytes. If the same content hash exists, it is deduped.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:push")`.

### Request headers

```http
Content-Type: application/octet-stream
```

### Request body

Raw binary payload (maximum size: 10 MB).

### Responses

**`201 Created`** (new content stored) or **`200 OK`** (content already exists/deduped).

```json
{
  "status": "success",
  "data": {
    "blobHash": "64-character-sha256-hash",
    "size": 12345,
    "deduped": false
  }
}
```

---

## `GET /api/workspace/blob/:repoId/:blobHash`

Get a short-lived signed URL to securely download a file blob from Cloudinary.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Path parameters

| Param | Rules | Description |
| --- | --- | --- |
| `repoId` | UUID | Repository ID. |
| `blobHash` | string | The 64-character SHA-256 blob hash. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "blobHash": "64-character-sha256-hash",
    "size": 12345,
    "url": "https://res.cloudinary.com/...&signature=...",
    "expiresAt": 1721382400
  }
}
```

---

## `POST /api/workspace/tree/upload/:repoId/:workspaceId`

Register uncommitted directory changes (the working directory) to the workspace. The server compares the uploaded array of `(filePath, blobHash)` against the workspace HEAD tree to derive action states:
- `blobHash` null + path in HEAD -> `DELETE`
- `blobHash` set + path not in HEAD -> `ADD`
- `blobHash` set + differs from HEAD -> `MODIFY`
- Identical or revert to HEAD -> `noop` (clears uncommitted row)

All files with non-null `blobHash` **must** be uploaded beforehand via `POST /api/workspace/blob/:repoId`.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:push")`.

### Request body

```json
{
  "changes": [
    { "filePath": "src/main.ts", "blobHash": "blob-hash-sha-1" },
    { "filePath": "deleted-file.txt", "blobHash": null }
  ]
}
```

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "summary": {
      "added": 0,
      "modified": 1,
      "deleted": 1,
      "noop": 0
    }
  }
}
```
