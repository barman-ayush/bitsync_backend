# 03 — Notification System Spec

## Table of Contents

1. [Database Tables](#1-database-tables)
2. [Notification Types & Triggers](#2-notification-types--triggers)
3. [Delivery Channels](#3-delivery-channels)
4. [Creating Notifications](#4-creating-notifications)
5. [Integration Points — Where Notifications Are Triggered](#5-integration-points--where-notifications-are-triggered)
6. [API Endpoints](#6-api-endpoints)
7. [Notification Payloads](#7-notification-payloads)

---

## 1. Database Tables

### 1.1 `notifications`

In-app notification system. Every notification belongs to one user (the **recipient** — `user_id`). An optional **actor** (`actor_id`) records who triggered it.

> **Invitations are folded into this table — there is no separate `invitations` table.** A repo invite *is* a `repo_invite` notification: the notification's own `id` is the actionable invite id, `data` holds `{ repoId, role }`, and `expires_at` holds the 7-day expiry. Accept/decline acts on the notification by its id, then the notification is hard-deleted (transient — no audit trail, consistent with the original invitation rule). Consequences of the fold-in: (1) you can only invite users who **already have an account** (a notification requires a real `user_id`, so pre-signup email invites are gone); (2) the old `UNIQUE(repo, invitee_email)` "one invite per person per repo" guard is no longer enforced at the DB level — enforce it in the invite endpoint if needed.

```sql
CREATE TYPE notification_type AS ENUM (
    'repo_invite',
    'invite_accepted',
    'invite_declined',
    'pr_created',
    'pr_merged',
    'pr_rejected',
    'pr_reviewed',
    'pr_reverted',
    'merge_conflicts',
    'member_removed',
    'role_changed'
);

CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- recipient (inbox owner)
    actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,          -- who triggered it; NULL for system events
    type            notification_type NOT NULL,
    title           VARCHAR(255) NOT NULL,
    body            TEXT,
    data            JSONB,                         -- structured payload, a snapshot (no FK) — survives source deletion
    is_read         BOOLEAN DEFAULT FALSE,
    expires_at      TIMESTAMPTZ,                   -- set for repo_invite (invite expiry); NULL otherwise
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- All notifications for a user (powers the notification list + unread badge).
-- Created by Prisma from @@index([userId, createdAt]).
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);

-- OPTIONAL optimizations (Prisma cannot express partial indexes — add via raw SQL if needed):
--   Unread badge count:
--     CREATE INDEX idx_notifications_user_unread ON notifications (user_id, created_at DESC) WHERE is_read = FALSE;
--   Invite-expiry cleanup job:
--     CREATE INDEX idx_notifications_invite_expiry ON notifications (expires_at) WHERE type = 'repo_invite';
```

> `actor_id` uses `ON DELETE SET NULL` so a notification survives the actor's account being deleted; the actor's *display name* is also snapshotted into `data`/`title` so the row still renders.

> **Email is out of scope here.** Notifications are **in-app only**. The only emails BitSync sends are auth emails (email verification, password reset), which are owned by the auth/email service — not this system.

---

## 2. Notification Types & Triggers

Every notification is created server-side when a specific event happens. Here's the complete map:

| Event | Type | Recipient(s) | Title Template | Trigger Location |
|-------|------|--------------|----------------|-----------------|
| User is invited to a repo | `repo_invite` | Invitee | "{inviter} invited you to {repo}" | RBAC spec §5.1 |
| Invitee accepts invitation | `invite_accepted` | Inviter | "{invitee} accepted your invite to {repo}" | RBAC spec §5.2 |
| Invitee declines invitation | `invite_declined` | Inviter | "{invitee} declined your invite to {repo}" | RBAC spec §5.3 |
| New PR is created | `pr_created` | All admins + owner (excl. author) | "{author} created a PR in {repo}: {pr_title}" | PR spec §4.1 |
| PR is merged | `pr_merged` | PR author | "Your PR was merged in {repo}: {pr_title}" | Merge spec §6.4 (finalize_merge) |
| PR is closed | `pr_rejected` | PR author | "Your PR was closed in {repo}: {pr_title}" | PR spec §4.5 |
| Review submitted on PR | `pr_reviewed` | PR author | "{reviewer} reviewed your PR: {pr_title}" | PR review creation |
| Merge is reverted | `pr_reverted` | PR author | "Your merged PR was reverted: {pr_title}" | Merge spec §9.1 (revert_merge) |
| Merge has conflicts | `merge_conflicts` | PR author | "Merge conflicts in {repo}: {pr_title}" | Merge spec §6.3 (three_way_merge) |
| User is removed from repo | `member_removed` | Removed user | "You were removed from {repo}" | RBAC spec §5.6 |
| User's role is changed | `role_changed` | Affected user | "Your role in {repo} changed from {old} to {new}" | RBAC spec §5.5 |

> All notifications are delivered **in-app only**. BitSync does not email users about repo/PR activity.

> **Note:** `repo_invite` / `invite_accepted` / `invite_declined` are the invitation mechanism itself, not pointers to a separate `invitations` table (see §1.1). The invite endpoint creates a `repo_invite` notification directly; accepting/declining acts on that notification by id.

---

## 3. Delivery Channel

Notifications are **in-app only** — there is a single delivery channel:

- Stored in `notifications` table
- Client fetches via `GET /notifications` (paginated, newest first)
- Unread count available via `GET /notifications/unread-count` (powers the badge)
- User marks as read individually or in bulk

**Polling vs Real-time:**
- **MVP**: Poll `GET /notifications/unread-count` every 30 seconds
- **Later**: WebSocket or Server-Sent Events (SSE) for instant delivery

> Email delivery is not part of this system. The only emails BitSync sends are auth emails (email verification, password reset), owned by the auth/email service.

---