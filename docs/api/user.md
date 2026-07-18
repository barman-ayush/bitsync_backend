# Users API

Routes mounted under `/api/user` (see `src/routes/user.routes.ts`).
Controller: `src/controllers/user.controller.ts`.
Validators: `src/validators/auth.validator.ts`.

For shared conventions, see [conventions.md](./conventions.md).

---

## `GET /api/user/check-username/:username`

Check whether a username is available for registration. Used by the signup form.

**Auth:** none.

### Path parameters

| Param | Rules |
| --- | --- |
| `username` | Same rules as registration username — 1–39 chars, `[a-zA-Z0-9-]`, no leading/trailing/consecutive hyphens, not reserved. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "username": "ayush",
    "available": true
  }
}
```

**Errors**
- `400 BadRequest` — validation failure.

---

## `GET /api/user/data`

Fetch the currently authenticated user's profile.

**Auth:** required (`authMiddleware`).

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "ayush",
    "displayName": "ayush",
    "avatarUrl": null,
    "emailVerified": true,
    "createdAt": "2026-05-28T10:00:00.000Z"
  }
}
```

**Errors**
- `401 Unauthorized` — not authenticated.
- `404 NotFound` — `"User not found"`.

---

## `GET /api/user/search/:username`

Fuzzy-search users whose normalized username **contains** the given substring. Excludes the caller from the results. Capped at 20 results.

**Auth:** required (`authMiddleware`).

### Path parameters

| Param | Rules |
| --- | --- |
| `username` | Must satisfy the standard username schema (1–39 chars, valid charset). |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": [
    {
      "id": "uuid",
      "displayName": "Ayush Barman",
      "email": "ayush@example.com"
    }
  ]
}
```

**Errors**
- `400 BadRequest` — validation failure.
- `401 Unauthorized` — not authenticated.

---

## `GET /api/user/search/repo/:username/:repoId`

Search users by username **excluding** anyone who is already a member of the given repository. Useful for the "invite user" picker.

**Auth:** required (`authMiddleware`). The caller must also be an active member of the target repository.

### Path parameters

| Param | Rules |
| --- | --- |
| `username` | Standard username schema. |
| `repoId` | UUID. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": [
    {
      "id": "uuid",
      "displayName": "Ayush Barman",
      "email": "ayush@example.com"
    }
  ]
}
```

**Errors**
- `400 BadRequest` — validation failure.
- `401 Unauthorized` — not authenticated, **or** the caller is not a member of the repo: `"You are not authorised to search for this repository."`

---

## `PATCH /api/user/update`

Update the authenticated user's profile display name and/or avatar. The avatar is uploaded to Cloudinary, and its URL is saved.

**Auth:** required (`authMiddleware`).

### Request body

```json
{
  "newDisplayName": "Ayush New Name",
  "avatarBlob": "data:image/png;base64,iVBORw0KGgoAAAAN..."
}
```

| Field | Rules |
| --- | --- |
| `newDisplayName` | Optional. String (1–100 chars). |
| `avatarBlob` | Optional. Base64 Data URL (e.g. `data:image/png;base64,...`) or raw base64 string. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "ayush",
    "displayName": "Ayush New Name",
    "avatarUrl": "https://res.cloudinary.com/demo/image/upload/v12345/avatars/uuid.png",
    "emailVerified": true,
    "createdAt": "2026-05-28T10:00:00.000Z",
    "updatedAt": "2026-05-28T10:05:00.000Z"
  }
}
```

**Errors**
- `400 BadRequest` — validation failure, or invalid base64 image data.
- `401 Unauthorized` — not authenticated.

---

## `GET /api/user/:username`

Fetch a user's profile by their username. Also lists matching repositories:
- If fetching your own username, lists all repositories you are an active member of.
- If fetching someone else's username, lists only common repositories that both of you are active members of.

**Auth:** required (`authMiddleware`).

### Path parameters

| Param | Rules |
| --- | --- |
| `username` | Standard username schema. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "displayName": "Ayush Barman",
      "avatarUrl": "https://res.cloudinary.com/...",
      "username": "ayush"
    },
    "repositories": [
      {
        "id": "uuid",
        "name": "bitsync",
        "description": "Repository description",
        "ownerId": "owner-uuid",
        "headCommit": "head-commit-hash",
        "createdAt": "2026-05-28T10:00:00.000Z",
        "updatedAt": "2026-05-28T10:00:00.000Z"
      }
    ]
  }
}
```

**Errors**
- `400 BadRequest` — validation failure.
- `401 Unauthorized` — not authenticated.
- `404 NotFound` — user not found.
