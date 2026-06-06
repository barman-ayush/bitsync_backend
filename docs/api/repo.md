# Repositories API

Routes mounted under `/api/repo` (see `src/routes/repo.routes.ts`).
Controller: `src/controllers/repo.controllers.ts`.
Validators: `src/validators/repo.validator.ts`.

All routes in this category require authentication (`authMiddleware` is applied router-wide).
Routes that operate on a specific repository additionally pass through `repoContext` and `authorize(<permission>)`.

For shared conventions and the full permission matrix, see [conventions.md](./conventions.md).

---

## `GET /api/repo/`

Search and list repositories the caller is a member of. Supports filtering, sorting, and pagination.

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
        "headCommit": null,
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

Check whether a repo name is available for the **currently authenticated owner**. (Names are unique per owner, not globally.)

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

Create a new repository. The caller is automatically added as the **owner**. An optional list of users can be added as initial members with `member` or `admin` role.

**Auth:** required.

### Request body

```json
{
  "name": "bitsync",
  "description": "Optional description",
  "users": [
    { "userId": "uuid", "role": "member" },
    { "userId": "uuid", "role": "admin" }
  ]
}
```

| Field | Rules |
| --- | --- |
| `name` | Required. 1–255 chars, valid repo-name charset. |
| `description` | Optional, ≤ 10000 chars. |
| `users` | Optional array of `{ userId, role }`. `role` must be `member` or `admin` (owner is reserved for the creator). Duplicates are silently skipped. |

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
    "role": "owner"
  }
}
```

**Errors**
- `400 BadRequest` — validation failure.
- `401 Unauthorized` — not authenticated.
- `409 Conflict` — `"You already have a repository with this name."`

---

## `GET /api/repo/:repoId`

Fetch a single repository the caller has access to. Includes the caller's role in the response.

**Auth + middleware chain:** `authMiddleware → repoContext → authorize("repo:view")`.

**Permission:** `repo:view` — `owner`, `admin`, or `member`.

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
    "headCommit": null,
    "createdAt": "2026-05-28T10:00:00.000Z",
    "updatedAt": "2026-05-28T10:00:00.000Z",
    "role": "owner"
  }
}
```

**Errors**
- `401 Unauthorized` — not authenticated.
- `404 NotFound` — repo does not exist **or** caller is not a member.

---

## `PUT /api/repo/:repoId`

Update a repository's name and/or description.

**Auth + middleware chain:** `authMiddleware → repoContext → authorize("repo:settings")`.

**Permission:** `repo:settings` — `owner` or `admin`.

### Request body

```json
{
  "name": "new-name",
  "description": "Updated description"
}
```

| Field | Rules |
| --- | --- |
| `name` | Required. Same rules as create. |
| `description` | Optional. `null` to clear, string ≤ 10000 chars to set. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Repository updated.",
  "data": {
    "id": "uuid",
    "name": "new-name",
    "description": "Updated description",
    "ownerId": "uuid",
    "headCommit": null,
    "createdAt": "2026-05-28T10:00:00.000Z",
    "updatedAt": "2026-05-28T10:00:00.000Z",
    "role": "owner"
  }
}
```

**Errors**
- `400 BadRequest` — validation failure.
- `403 Forbidden` — `"Insufficient permissions"` (caller is a member, not owner/admin).
- `404 NotFound` — repo not found / caller not a member.
- `409 Conflict` — `"You already have a repository with this name."`

---

## `POST /api/repo/user/invite/:repoId`

Invite a user to join the repository. The invitee receives an email and an in-app invitation. Admins can only invite as `member`; owners can invite as `admin` or `member`.

**Auth + middleware chain:** `authMiddleware → repoContext → authorize("repo:settings")`.

**Permission:** `repo:settings` — `owner` or `admin` (with extra in-controller checks for admin invites).

### Request body

```json
{
  "invitee_user_id": "uuid",
  "invitee_user_role": "member"
}
```

| Field | Rules |
| --- | --- |
| `invitee_user_id` | Required UUID of the user being invited. Cannot equal the caller. |
| `invitee_user_role` | Required. `"admin"` or `"member"`. |

### Responses

**`201 Created`**

```json
{
  "status": "success",
  "message": "Invitation sent.",
  "data": {
    "id": "uuid",
    "repoId": "uuid",
    "inviteeId": "uuid",
    "inviteeEmail": "user@example.com",
    "role": "member",
    "expiresAt": "2026-06-04T10:00:00.000Z",
    "createdAt": "2026-05-28T10:00:00.000Z"
  }
}
```

**Errors**
- `400 BadRequest` — validation failure.
- `403 Forbidden` — `"User cannot be self-invited"` / `"Insufficient permissions"` / `"Admins can only invite members."`
- `404 NotFound` — repo or invitee not found.
- `409 Conflict` — `"User is already a member of this repository."` / `"A pending invitation already exists for this user."`

> Note: there is exactly one invitation per `(repo, invitee)`. Expired invitations are hard-deleted and replaced by the new one within the same transaction.

---

## `POST /api/repo/user/remove/:repoId`

Remove a member from the repository (soft delete on `RepoMember`). Also deletes any pending invitations involving that user for this repo.

**Auth + middleware chain:** `authMiddleware → repoContext → authorize("member:remove")`.

**Permission:** `member:remove` — `owner` or `admin`. Additional in-controller rules:
- Cannot remove yourself (use a leave-repo flow instead).
- Cannot remove the owner.
- Admins cannot remove other admins (only owners can).

### Request body

```json
{
  "invitee_user_id": "uuid",
  "invitee_user_role": "member"
}
```

> The schema requires `invitee_user_role` to be present, but the controller does not act on it for this endpoint.

### Responses

**`200 OK`**

```json
{ "status": "success", "message": "Member removed." }
```

**Errors**
- `400 BadRequest` — `"Use leave repository instead."` if `invitee_user_id` equals the caller.
- `403 Forbidden` — `"Owner cannot be removed."` / `"Admins can only remove members."` / `"Insufficient permissions"`.
- `404 NotFound` — repo or target member not found.

---

## `POST /api/repo/user/promote/:repoId`

Promote a `member` to `admin`. Idempotent: if the target is already an admin, returns `200` with a no-op message.

**Auth + middleware chain:** `authMiddleware → repoContext → authorize("member:promote")`.

**Permission:** `member:promote` — `owner` or `admin`. Additional rules:
- Cannot change your own role.
- Cannot promote the owner.

### Request body

```json
{
  "invitee_user_id": "uuid",
  "invitee_user_role": "admin"
}
```

### Responses

**`200 OK` (promoted)**

```json
{
  "status": "success",
  "message": "Member promoted to admin.",
  "data": { "invitee_user_id": "uuid", "role": "admin" }
}
```

**`200 OK` (already admin)**

```json
{ "status": "success", "message": "User already an admin." }
```

**Errors**
- `400 BadRequest` — `"Cannot change your own role."` / `"Cannot promote owners."`
- `403 Forbidden` — `"Insufficient permissions"`.
- `404 NotFound` — repo or target member not found.

---

## `POST /api/repo/user/demote/:repoId`

Demote an `admin` to `member`. **Owner-only operation.** Also rewrites any pending `admin` invitations from that user to `member`, and deletes invitations that user had sent for this repo.

**Auth + middleware chain:** `authMiddleware → repoContext → authorize("member:demote")`.

**Permission:** `member:demote` — `owner` only. Additional rules:
- Cannot change your own role.
- Cannot demote the owner.
- Cannot demote a `member` (already lowest role).

### Request body

```json
{
  "invitee_user_id": "uuid",
  "invitee_user_role": "member"
}
```

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Admin demoted to member.",
  "data": { "invitee_user_id": "uuid", "role": "member" }
}
```

**Errors**
- `400 BadRequest` — `"Cannot change your own role."` / `"Members cannot be demoted any further."`
- `403 Forbidden` — `"Only owners can demote admins."` / `"Owners cannot be demoted."` / `"Insufficient permissions"`.
- `404 NotFound` — repo or target member not found.
