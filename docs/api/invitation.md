# Invitations API

Routes mounted under `/api/invitation` (see `src/routes/invitation.routes.ts`).
Controller: `src/controllers/invitation.controllers.ts`.

All routes in this category require authentication (`authMiddleware` is applied router-wide).

For shared conventions, see [conventions.md](./conventions.md).

> **Invitation model.** There is at most **one invitation per `(repo, invitee)`**. Invitations are transient — they are hard-deleted on accept/reject/delete and replaced (not kept as an audit trail).

---

## `POST /api/invitation/:id/accept`

Accept an invitation. On success the invitation is deleted and the caller is upserted into `RepoMember` with the role specified by the invitation. If the caller had previously been soft-deleted from this repo, they are reactivated.

**Auth:** required.

### Path parameters

| Param | Description |
| --- | --- |
| `id` | The invitation ID. |

### Validation
- The invitation must exist.
- The invitation must not be expired.
- The caller's `userId` and `email` must match the invitation (`inviteeId` may be `null`, but `inviteeEmail` is checked against the caller's email).
- The caller must not already be an active member of the repository.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Invitation accepted.",
  "data": {
    "repoId": "uuid",
    "role": "member"
  }
}
```

**Errors**
- `400 BadRequest` — `"Invitation has expired."`
- `401 Unauthorized` — not authenticated.
- `403 Forbidden` — `"This invitation is not for you."`
- `404 NotFound` — `"Invitation not found."`
- `409 Conflict` — `"You are already a member of this repository."`

---

## `POST /api/invitation/:id/reject`

Reject (decline) an invitation. The invitation row is **hard-deleted**.

**Auth:** required.

### Path parameters

| Param | Description |
| --- | --- |
| `id` | The invitation ID. |

### Validation
- The invitation must exist.
- The caller must be the invitee (same `userId`/`email` rules as accept).

### Responses

**`200 OK`**

```json
{ "status": "success", "message": "Invitation declined." }
```

**Errors**
- `401 Unauthorized` — not authenticated, or user lookup failed: `"User not found."`
- `403 Forbidden` — `"This invitation is not for you."`
- `404 NotFound` — `"Invitation not found."`

---

## `DELETE /api/invitation/:id`

Delete an invitation **you sent**. Used by the inviter to retract a pending invite.

**Auth:** required. The caller must be the inviter.

### Path parameters

| Param | Description |
| --- | --- |
| `id` | The invitation ID. |

### Responses

**`200 OK`**

```json
{ "status": "success", "message": "Invitation deleted." }
```

**Errors**
- `401 Unauthorized` — not authenticated.
- `403 Forbidden` — `"Only the inviter can delete this invitation."`
- `404 NotFound` — `"Invitation not found."`
