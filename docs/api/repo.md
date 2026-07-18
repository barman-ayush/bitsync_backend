# Repositories API

Routes mounted under `/api/repo` (see `src/routes/repo.routes.ts`).
Controller: `src/controllers/repo.controllers.ts`.
Validators: `src/validators/repo.validator.ts`.

All routes in this category require authentication (`authMiddleware` is applied router-wide).
Routes that operate on a specific repository additionally pass through `repoContext` (or `resolveRepoBySlug`) and `authorize(<permission>)`.

For shared conventions and the full permission matrix, see [conventions.md](./conventions.md).

---

## `GET /api/repo/`

Search and list repositories the caller is an active member of. Supports filtering, sorting, and pagination.

**Auth:** required.

### Query parameters

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `q` | string (1–255) | — | Text search across repo name, description, and owner username. |
| `owner` | string | — | Owner UUID or username (auto-detected by UUID regex). |
| `role` | `owner` \| `admin` \| `member` | — | Filter by the caller's role in each repo. |
| `created_from` | ISO date | — | Lower bound on `createdAt`. |
| `created_to` | ISO date | — | Upper bound on `createdAt`. Must be ≥ `created_from`. |
| `has_commits` | `"true"` \| `"false"` | — | Filter on `headCommit` being null/non-null. |
| `sort` | `created` \| `updated` \| `name` | `updated` | Field to sort by. |
| `direction` | `asc` \| `desc` | `desc` | Sort direction. |
| `page` | integer ≥ 1 | `1` | Page number. |
| `per_page` | integer 1–100 | `30` | Page size. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "items": [
      {
        "id": "uuid",
        "name": "bitsync",
        "description": "Project description",
        "ownerId": "uuid",
        "owner": {
          "username": "ayush",
          "usernameNormalized": "ayush",
          "avatarUrl": null
        },
        "headCommit": "commit-hash",
        "createdAt": "2026-05-28T10:00:00.000Z",
        "updatedAt": "2026-05-28T10:00:00.000Z",
        "role": "owner"
      }
    ],
    "page": 1,
    "per_page": 30,
    "total_count": 1,
    "total_pages": 1
  }
}
```

**Errors**
- `400 BadRequest` — validation failure.
- `401 Unauthorized` — not authenticated.

---

## `GET /api/repo/check-name/:repoName`

Check whether a repo name is available for the **currently authenticated user** (Names are unique per owner/creator, not globally).

**Auth:** required.

### Path parameters

| Param | Rules |
| --- | --- |
| `repoName` | 1–255 chars, `[a-zA-Z0-9-]` only, no leading/trailing/consecutive hyphens. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "name": "bitsync",
    "available": true
  }
}
```

**Errors**
- `400 BadRequest` — validation failure.
- `401 Unauthorized` — not authenticated.

---

## `POST /api/repo/create`

Create a new repository. The caller is automatically added as the `owner`. An optional list of email addresses can be provided to invite initial contributors as admins or members.

**Auth:** required.

### Request body

```json
{
  "name": "bitsync",
  "description": "Optional description",
  "users": [
    { "email": "contributor1@example.com", "role": "member" },
    { "email": "contributor2@example.com", "role": "admin" }
  ]
}
```

| Field | Rules |
| --- | --- |
| `name` | Required. 1–255 chars, valid repo-name charset. |
| `description` | Optional, ≤ 10000 chars. |
| `users` | Optional array of `{ email, role }`. `role` must be `member` or `admin`. Maximum of 50 users. |

### Responses

**`201 Created`**

```json
{
  "status": "success",
  "message": "Repository created.",
  "data": {
    "id": "uuid",
    "name": "bitsync",
    "description": "Optional description",
    "ownerId": "uuid",
    "headCommit": null,
    "createdAt": "2026-05-28T10:00:00.000Z",
    "updatedAt": "2026-05-28T10:00:00.000Z",
    "role": "owner",
    "invites": {
      "invited": 2,
      "updated": 0,
      "skipped": 0,
      "notFound": [],
      "alreadyMember": []
    }
  }
}
```

**Errors**
- `400 BadRequest` — validation failure.
- `401 Unauthorized` — not authenticated.
- `409 Conflict` — `"You already have a repository with this name."`

---

## `POST /api/repo/invite/accept`

Accept a repository invitation. The corresponding notification is consumed (deleted).

**Auth:** required.

### Request body

```json
{
  "notificationId": "uuid"
}
```

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "You joined bitsync as member."
}
```

**Errors**
- `400 BadRequest` — `"This invitation has expired. Ask for a new invite."`
- `401 Unauthorized` — not authenticated.
- `404 NotFound` — `"Invitation not found."` or `"repository no longer exists."`

---

## `POST /api/repo/invite/decline`

Decline (decline) a repository invitation. The corresponding notification is consumed (deleted).

**Auth:** required.

### Request body

```json
{
  "notificationId": "uuid"
}
```

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Invitation to bitsync declined."
}
```

**Errors**
- `401 Unauthorized` — not authenticated.
- `404 NotFound` — `"Invitation not found."`

---

## `GET /api/repo/:repoId/contributors`

Fetch a list of all active contributors (members/admins/owner) of a repository.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Path parameters

| Param | Rules |
| --- | --- |
| `repoId` | Valid UUID. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": [
    {
      "role": "owner",
      "joinedAt": "2026-05-28T10:00:00.000Z",
      "user": {
        "id": "uuid",
        "displayName": "Ayush Barman",
        "username": "ayush",
        "email": "ayush@example.com",
        "avatarUrl": null
      }
    }
  ]
}
```

**Errors**
- `401 Unauthorized` — not authenticated.
- `404 NotFound` — repository not found / caller not a member.

---

## `GET /api/repo/:repoId/reviewers/search`

Search active members of the repository to assign as reviewers (excluding the current user).

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Path parameters

| Param | Rules |
| --- | --- |
| `repoId` | Valid UUID. |

### Query parameters

| Param | Type | Rules | Description |
| --- | --- | --- | --- |
| `q` | string | Optional | Text search by displayName, email, or username. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": [
    {
      "id": "uuid",
      "displayName": "Reviewer User",
      "username": "reviewer",
      "email": "reviewer@example.com",
      "avatarUrl": "https://res.cloudinary.com/...",
      "role": "member"
    }
  ]
}
```

---

## `POST /api/repo/:repoId/invite`

Invite a batch of users (by email) to join the repository. Owners can invite users as `admin` or `member`; Admins can only invite users as `member`.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("member:invite")`.

### Request body

```json
[
  { "email": "user1@example.com", "role": "member" },
  { "email": "user2@example.com", "role": "admin" }
]
```

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Invitations processed.",
  "data": {
    "invited": 2,
    "updated": 0,
    "skipped": 0,
    "notFound": [],
    "alreadyMember": []
  }
}
```

---

## `POST /api/repo/:repoId/leave`

Leave the repository. The active member removes themselves. The repository owner **cannot** leave the repository (must transfer ownership or delete repository instead).

**Auth + middleware chain:** `authMiddleware → requireRepoAccess`.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "You left the repository."
}
```

**Errors**
- `403 Forbidden` — `"Owner cannot leave the repository. Transfer ownership or delete it instead."`

---

## `POST /api/repo/:repoId/remove`

Remove a member from the repository (soft delete on membership).
- Cannot remove yourself.
- Cannot remove the owner.
- Admins cannot remove other admins (only owners can).

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("member:remove")`.

### Request body

```json
{
  "userId": "uuid"
}
```

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "User removed from the repository."
}
```

---

## `POST /api/repo/:repoId/promote`

Promote a `member` to `admin`.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("member:promote")`.

### Request body

```json
{
  "userId": "uuid"
}
```

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "User promoted to admin."
}
```

**Errors**
- `409 Conflict` — `"User is already an admin."`

---

## `POST /api/repo/:repoId/demote`

Demote an `admin` to `member`. **Owner-only operation.**

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("member:demote")`.

### Request body

```json
{
  "userId": "uuid"
}
```

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "User demoted to member."
}
```

**Errors**
- `409 Conflict` — `"User is already a member."`

---

## `GET /api/repo/get-data/:repoId`

Fetch files and directories representing the repository's main line HEAD state.

**Auth + middleware chain:** `authMiddleware → requireRepoAccess → authorize("repo:view")`.

### Query parameters

| Param | Type | Description |
| --- | --- | --- |
| `treeHash` | string | Optional. Tree hash of a sub-directory to list. If omitted, lists the HEAD commit's root tree directory. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Repository data fetched successfully.",
  "data": {
    "tree": [
      {
        "name": "src",
        "type": "tree",
        "objectHash": "tree-hash-uuid"
      },
      {
        "name": "package.json",
        "type": "blob",
        "objectHash": "blob-hash-sha",
        "size": 1434
      }
    ]
  }
}
```

---

## `GET /api/repo/:username/:reponame`

Page-mount entry point to resolve and fetch repository metadata by owner username and repository name slug.

**Auth + middleware chain:** `authMiddleware → resolveRepoBySlug → authorize("repo:view")`.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "id": "uuid",
    "name": "bitsync",
    "description": "Optional description",
    "ownerId": "uuid",
    "headCommit": "commit-hash",
    "createdAt": "2026-05-28T10:00:00.000Z",
    "updatedAt": "2026-05-28T10:00:00.000Z",
    "role": "owner"
  }
}
```
