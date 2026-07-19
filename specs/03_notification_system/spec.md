# 03 — Notification System Spec

This specification details the design for the in-app notification system in BitSync.

## 1. Data Model

BitSync notifications are stored in a single table:

### 1.1 Notifications
- `id` (UUID, Primary Key)
- `userId` (UUID, Foreign Key referencing Users) — The recipient of the notification.
- `actorId` (UUID, Foreign Key referencing Users, nullable) — The user who triggered the event.
- `type` (enum representing the notification type)
- `title` (string)
- `body` (string)
- `data` (JSONB) — Arbitrary metadata snapshot (e.g. `repoId`, `role`, `prTitle`, `actorName`).
- `isRead` (boolean, defaults to false)
- `expiresAt` (timestamp, nullable) — Used for `repo_invite` TTL.
- `createdAt` (timestamp with timezone)

---

## 2. Notification Types & Triggers

Notifications are created synchronously on the server as side effects of user actions. The system supports the following triggers:

| Event | Notification Type | Recipient(s) | Triggering Action |
| --- | --- | --- | --- |
| User invited to repository | `repo_invite` | Invitee | Owner or admin invites a contributor by email |
| Invitee accepts invitation | `invite_accepted` | Inviter | User accepts pending repository invite |
| Invitee declines invitation | `invite_declined` | Inviter | User declines pending repository invite |
| User removed from repository | `member_removed` | Removed User | Owner or admin removes a contributor |
| User role changed in repository | `role_changed` | Affected User | Owner promotes/demotes a member or admin |
| New Pull Request opened | `pr_created` | Repository Admins & Owner | Contributor creates a Pull Request |
| Pull Request closed | `pr_rejected` | Pull Request Author | User closes an open Pull Request |
| Conflicts detected on PR merge | `merge_conflicts` | Pull Request Author | Automatic dry-run merge check finds conflicts |
| Pull Request review comment added | `pr_reviewed` | Pull Request Author | Contributor adds a comment to a Pull Request |

---

## 3. Delivery Channels

All notifications are delivered **in-app only**:
- Notifications are fetched by querying the `/api/notification/` endpoint (newest first).
- The client checks for unread notifications by pulling the inbox status or loading the list.
- A user can mark individual notifications as read or mark all notifications in their inbox as read in bulk.