# Notifications API

Routes mounted under `/api/notification` (see `src/routes/notification.routes.ts`).
Controller: `src/controllers/notification.controller.ts`.
Validators: `src/validators/notification.validator.ts`.

All routes in this category require authentication (`authMiddleware` is applied router-wide).

For shared conventions, see [conventions.md](./conventions.md).

---

## `GET /api/notification/`

Retrieve the notification inbox for the currently authenticated user.

**Auth:** required.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "data": {
    "notifications": [
      {
        "id": "uuid",
        "userId": "recipient-user-uuid",
        "actorId": "actor-user-uuid",
        "type": "repo_invite",
        "context": {
          "actorName": "ayush",
          "repoName": "bitsync"
        },
        "data": {
          "repoId": "repository-uuid",
          "repoName": "bitsync",
          "role": "member"
        },
        "isRead": false,
        "expiresAt": "2026-06-04T10:00:00.000Z",
        "createdAt": "2026-05-28T10:00:00.000Z",
        "updatedAt": "2026-05-28T10:00:00.000Z",
        "actor": {
          "email": "actor@example.com",
          "displayName": "Ayush Barman",
          "avatarUrl": null
        }
      }
    ]
  }
}
```

**Errors**
- `401 Unauthorized` — not authenticated.

---

## `PATCH /api/notification/:notificationId/read`

Mark a specific notification as read. The notification must belong to the authenticated user.

**Auth:** required.

### Path parameters

| Param | Rules |
| --- | --- |
| `notificationId` | Valid UUID. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "Notification marked as read."
}
```

**Errors**
- `400 BadRequest` — validation failure.
- `401 Unauthorized` — not authenticated.
- `404 NotFound` — notification not found or doesn't belong to caller.

---

## `PATCH /api/notification/read-all`

Mark all unread notifications in the caller's inbox as read. Idempotent operation.

**Auth:** required.

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "All notifications marked as read.",
  "data": {
    "updated": 3
  }
}
```

**Errors**
- `401 Unauthorized` — not authenticated.
