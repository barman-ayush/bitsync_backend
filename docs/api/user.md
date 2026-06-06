# Users API

Routes mounted under `/api/user` (see `src/routes/user.routes.ts`).
Controller: `src/controllers/user.controller.ts`.

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

**Auth:** required (`authMiddleware`). The caller must also be a member of the target repository.

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
