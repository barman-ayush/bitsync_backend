# 03 — Notification System Spec

## Table of Contents

1. [Database Tables](#1-database-tables)
2. [Notification Types & Triggers](#2-notification-types--triggers)
3. [Delivery Channels](#3-delivery-channels)
4. [Creating Notifications](#4-creating-notifications)
5. [Integration Points — Where Notifications Are Triggered](#5-integration-points--where-notifications-are-triggered)
6. [Signup — Linking Pending Invitations](#6-signup--linking-pending-invitations)
7. [API Endpoints](#7-api-endpoints)
8. [Notification Payloads](#8-notification-payloads)

---

## 1. Database Tables

### 1.1 `notifications`

In-app notification system. Every notification belongs to one user.

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
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            notification_type NOT NULL,
    title           VARCHAR(255) NOT NULL,
    body            TEXT,
    data            JSONB,                         -- structured payload for client-side routing
    is_read         BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Unread notifications (most queried — powers the badge count)
CREATE INDEX idx_notifications_user_unread ON notifications (user_id, created_at DESC)
    WHERE is_read = FALSE;

-- All notifications for a user (powers the notification list)
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);
```

### 1.2 `email_queue` (optional — for async email delivery)

If using a job queue for sending emails asynchronously:

```sql
CREATE TYPE email_status AS ENUM ('pending', 'sent', 'failed');

CREATE TABLE email_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    to_email        VARCHAR(255) NOT NULL,
    subject         VARCHAR(255) NOT NULL,
    template        VARCHAR(50) NOT NULL,          -- template name (e.g., 'repo_invite')
    template_data   JSONB NOT NULL,                -- data to render the template
    status          email_status DEFAULT 'pending',
    attempts        INT DEFAULT 0,
    max_attempts    INT DEFAULT 3,
    last_error      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    sent_at         TIMESTAMPTZ
);

CREATE INDEX idx_email_queue_pending ON email_queue (created_at)
    WHERE status = 'pending';
```

**Note:** For MVP, you can skip `email_queue` and send emails directly (synchronously or with a simple `setTimeout`). Add the queue when email reliability matters.

---

## 2. Notification Types & Triggers

Every notification is created server-side when a specific event happens. Here's the complete map:

| Event | Type | Recipient(s) | Title Template | In-App | Email | Trigger Location |
|-------|------|--------------|----------------|--------|-------|-----------------|
| User is invited to a repo | `repo_invite` | Invitee | "{inviter} invited you to {repo}" | Yes | Yes | RBAC spec §5.1 |
| Invitee accepts invitation | `invite_accepted` | Inviter | "{invitee} accepted your invite to {repo}" | Yes | No | RBAC spec §5.2 |
| Invitee declines invitation | `invite_declined` | Inviter | "{invitee} declined your invite to {repo}" | Yes | No | RBAC spec §5.3 |
| New PR is created | `pr_created` | All admins + owner (excl. author) | "{author} created a PR in {repo}: {pr_title}" | Yes | Yes | PR spec §4.1 |
| PR is merged | `pr_merged` | PR author | "Your PR was merged in {repo}: {pr_title}" | Yes | Yes | Merge spec §6.4 (finalize_merge) |
| PR is closed | `pr_rejected` | PR author | "Your PR was closed in {repo}: {pr_title}" | Yes | Yes | PR spec §4.5 |
| Review submitted on PR | `pr_reviewed` | PR author | "{reviewer} reviewed your PR: {pr_title}" | Yes | Yes | PR review creation |
| Merge is reverted | `pr_reverted` | PR author | "Your merged PR was reverted: {pr_title}" | Yes | Yes | Merge spec §9.1 (revert_merge) |
| Merge has conflicts | `merge_conflicts` | PR author | "Merge conflicts in {repo}: {pr_title}" | Yes | Yes | Merge spec §6.3 (three_way_merge) |
| User is removed from repo | `member_removed` | Removed user | "You were removed from {repo}" | Yes | Yes | RBAC spec §5.6 |
| User's role is changed | `role_changed` | Affected user | "Your role in {repo} changed from {old} to {new}" | Yes | Yes | RBAC spec §5.5 |

---

## 3. Delivery Channels

### 3.1 In-App Notifications

- Stored in `notifications` table
- Client fetches via `GET /notifications` (paginated, newest first)
- Unread count available via `GET /notifications/unread-count` (powers the badge)
- User marks as read individually or in bulk

**Polling vs Real-time:**
- **MVP**: Poll `GET /notifications/unread-count` every 30 seconds
- **Later**: WebSocket or Server-Sent Events (SSE) for instant delivery

### 3.2 Email Notifications

Only sent for important events (see table above — the "Email" column).

**Email templates needed:**

| Template | When | Content |
|----------|------|---------|
| `repo_invite` | User invited to repo | Repo name, inviter name, accept/decline buttons linking to the app |
| `pr_created` | New PR in repo | Repo name, PR title, author, link to PR |
| `pr_merged` | PR was merged | Repo name, PR title, link to merged PR |
| `pr_rejected` | PR was rejected | Repo name, PR title, link to PR |
| `member_removed` | User removed from repo | Repo name, reason if any |
| `role_changed` | User's role changed | Repo name, old role, new role |
| `verify_email` | New signup | Verification link (24h expiry) |
| `reset_password` | Password reset request | Reset link (1h expiry) |

---

## 4. Creating Notifications

### 4.1 Core Function

```javascript
/**
 * Create an in-app notification and optionally queue an email.
 *
 * @param {string} userId - Recipient user ID
 * @param {string} type - Notification type (from enum)
 * @param {object} context - Data used to build the notification
 */
async function createNotification(userId, type, context) {
    // 1. Build title and body from type + context
    const { title, body } = buildNotificationContent(type, context);

    // 2. Insert in-app notification
    await db.query(
        'INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, $2, $3, $4, $5)',
        [userId, type, title, body, JSON.stringify(context)]
    );

    // 3. Check if this type should also send an email
    if (SHOULD_EMAIL[type]) {
        const user = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
        await queueEmail(user.email, type, context);
    }
}

// Which notification types also trigger an email
const SHOULD_EMAIL = {
    'repo_invite':      true,
    'invite_accepted':  false,
    'invite_declined':  false,
    'pr_created':       true,
    'pr_merged':        true,
    'pr_rejected':      true,
    'pr_reviewed':      true,
    'pr_reverted':      true,
    'merge_conflicts':  true,
    'member_removed':   true,
    'role_changed':     true,
};
```

### 4.2 Building Notification Content

```javascript
function buildNotificationContent(type, context) {
    switch (type) {
        case 'repo_invite':
            return {
                title: `${context.inviterName} invited you to ${context.repoName}`,
                body: `You've been invited to join as a ${context.role}. Accept or decline the invitation.`
            };

        case 'invite_accepted':
            return {
                title: `${context.inviteeName} accepted your invite to ${context.repoName}`,
                body: `${context.inviteeName} is now a ${context.role} of ${context.repoName}.`
            };

        case 'invite_declined':
            return {
                title: `${context.inviteeName} declined your invite to ${context.repoName}`,
                body: null
            };

        case 'pr_created':
            return {
                title: `New PR in ${context.repoName}: ${context.prTitle}`,
                body: `${context.authorName} created a pull request.`
            };

        case 'pr_merged':
            return {
                title: `Your PR was merged: ${context.prTitle}`,
                body: `Your pull request in ${context.repoName} has been merged.`
            };

        case 'pr_rejected':
            return {
                title: `Your PR was rejected: ${context.prTitle}`,
                body: `Your pull request in ${context.repoName} was rejected.`
            };

        case 'member_removed':
            return {
                title: `You were removed from ${context.repoName}`,
                body: context.reason === 'repository_deleted'
                    ? 'The repository was deleted.'
                    : 'You are no longer a member of this repository.'
            };

        case 'pr_reviewed':
            return {
                title: `${context.reviewerName} reviewed your PR: ${context.prTitle}`,
                body: `Verdict: ${context.verdict}. ${context.reviewBody || ''}`
            };

        case 'pr_reverted':
            return {
                title: `Your merged PR was reverted: ${context.prTitle}`,
                body: `${context.revertedByName} reverted the merge in ${context.repoName}.`
            };

        case 'merge_conflicts':
            return {
                title: `Merge conflicts in ${context.repoName}: ${context.prTitle}`,
                body: `${context.conflictCount} file(s) have conflicts that need resolution.`
            };

        case 'role_changed':
            return {
                title: `Your role in ${context.repoName} was changed`,
                body: `Your role changed from ${context.oldRole} to ${context.newRole}.`
            };
    }
}
```

### 4.3 Batch Notifications (for multi-recipient events)

Some events notify multiple users (e.g., `pr_created` notifies all admins + owner):

```javascript
/**
 * Notify all admins and owner of a repo about an event.
 * Excludes the actor (don't notify yourself).
 */
async function notifyRepoAdmins(repoId, actorId, type, context) {
    const adminsAndOwner = await db.query(
        "SELECT user_id FROM repo_members WHERE repo_id = $1 AND role IN ('owner', 'admin') AND user_id != $2",
        [repoId, actorId]
    );

    for (const { user_id } of adminsAndOwner) {
        await createNotification(user_id, type, context);
    }
}
```

---

## 5. Integration Points — Where Notifications Are Triggered

Notifications are triggered directly from the business logic functions. Each trigger point calls `createNotification()` or `notifyRepoAdmins()` after the core operation succeeds.

### 5.1 Version Control Triggers

| Event | Trigger Location | Function Call |
|-------|-----------------|---------------|
| PR created | `create_pr()` — PR spec §4.1, after successful insert | `notifyRepoAdmins(repo_id, author_id, "pr_created", { repoName, prTitle, authorName, prId })` |
| PR merged (clean) | `finalize_merge()` — Merge spec §6.4, after step 5 (freeze PR) | `createNotification(pr.author_id, "pr_merged", { repoName, prTitle, prId, mergeCommit })` |
| PR closed | `close_pr()` — PR spec §4.5, after status update | `createNotification(pr.author_id, "pr_rejected", { repoName, prTitle, prId, closedBy })` |
| Merge conflicts | `three_way_merge()` — Merge spec §6.3, after conflicts stored | `createNotification(pr.author_id, "merge_conflicts", { repoName, prTitle, prId, conflictCount })` |
| Merge reverted | `revert_merge()` — Merge spec §9.1, step 5 | `createNotification(pr.author_id, "pr_reverted", { repoName, prTitle, prId, revertedByName, revertCommit })` |
| Review submitted | PR review creation endpoint | `createNotification(pr.author_id, "pr_reviewed", { repoName, prTitle, prId, reviewerName, verdict, reviewBody })` |

### 5.2 RBAC Triggers

These are already documented in the RBAC spec. For completeness:

| Event | Trigger Location |
|-------|-----------------|
| Repo invite | RBAC §5.1 — after invitation created |
| Invite accepted | RBAC §5.2 — after membership created |
| Invite declined | RBAC §5.3 — after invitation status updated |
| Member removed | RBAC §5.6 — after membership deleted |
| Role changed | RBAC §5.5 — after role updated |
| Repo deleted | RBAC §5.7 — after soft delete, notify all members |

---

## 6. Signup — Linking Pending Invitations

When a new user signs up, check if they have pending invitations and create notifications:

```javascript
/**
 * Called after a new user is created (email signup or OAuth).
 * Links any pending invitations to this user and creates notifications.
 */
async function linkPendingInvitations(userId, email) {
    const pendingInvites = await db.query(
        "SELECT * FROM invitations WHERE invitee_email = $1 AND status = 'pending' AND expires_at > NOW()",
        [email]
    );

    for (const invite of pendingInvites) {
        // Link the invitation to this user
        await db.query(
            'UPDATE invitations SET invitee_id = $1 WHERE id = $2',
            [userId, invite.id]
        );

        // Fetch context for the notification
        const repo = await db.query('SELECT name FROM repositories WHERE id = $1', [invite.repo_id]);
        const inviter = await db.query('SELECT display_name FROM users WHERE id = $1', [invite.inviter_id]);

        // Create in-app notification
        await createNotification(userId, 'repo_invite', {
            repoId: invite.repo_id,
            repoName: repo.name,
            inviterId: invite.inviter_id,
            inviterName: inviter.display_name,
            invitationId: invite.id,
            role: invite.role
        });
    }
}
```

---

## 7. API Endpoints

### Notification Endpoints

```
GET    /notifications                     — list notifications (paginated)
GET    /notifications/unread-count        — unread count (for badge)
PATCH  /notifications/:id/read           — mark one as read
POST   /notifications/read-all           — mark all as read
```

All endpoints require authentication.

### Query Parameters for `GET /notifications`

```
GET /notifications?page=1&limit=20&unread_only=false

page        — page number (default: 1)
limit       — items per page (default: 20, max: 50)
unread_only — if true, only return unread notifications (default: false)
```

### Response Format

```json
// GET /notifications
{
    "notifications": [
        {
            "id": "uuid",
            "type": "repo_invite",
            "title": "John invited you to BitSync",
            "body": "You've been invited to join as a member.",
            "data": {
                "repoId": "uuid",
                "invitationId": "uuid"
            },
            "is_read": false,
            "created_at": "2026-03-29T10:00:00Z"
        }
    ],
    "pagination": {
        "page": 1,
        "limit": 20,
        "total": 45,
        "total_pages": 3
    }
}

// GET /notifications/unread-count
{
    "count": 3
}
```

### Controller Implementation

```javascript
async function listNotifications(req, res) {
    const { page = 1, limit = 20, unread_only = false } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT * FROM notifications WHERE user_id = $1';
    let countQuery = 'SELECT COUNT(*) FROM notifications WHERE user_id = $1';
    const params = [req.user.id];

    if (unread_only === 'true') {
        query += ' AND is_read = FALSE';
        countQuery += ' AND is_read = FALSE';
    }

    query += ' ORDER BY created_at DESC LIMIT $2 OFFSET $3';
    params.push(limit, offset);

    const [notifications, total] = await Promise.all([
        db.query(query, params),
        db.query(countQuery, [req.user.id])
    ]);

    res.json({
        notifications,
        pagination: {
            page: Number(page),
            limit: Number(limit),
            total: Number(total.count),
            total_pages: Math.ceil(total.count / limit)
        }
    });
}

async function getUnreadCount(req, res) {
    const result = await db.query(
        'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE',
        [req.user.id]
    );
    res.json({ count: Number(result.count) });
}

async function markAsRead(req, res) {
    await db.query(
        'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
        [req.params.id, req.user.id]
    );
    res.json({ success: true });
}

async function markAllAsRead(req, res) {
    await db.query(
        'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE',
        [req.user.id]
    );
    res.json({ success: true });
}
```

---

## 8. Notification Payloads

The `data` JSONB field contains structured data for client-side routing. When the user clicks a notification, the client uses this data to navigate to the right page.

| Type | `data` fields | Client navigates to |
|------|---------------|---------------------|
| `repo_invite` | `{ repoId, invitationId, role }` | Invitation accept/decline page |
| `invite_accepted` | `{ repoId, inviteeId }` | Repo members page |
| `invite_declined` | `{ repoId, inviteeId }` | Repo members page |
| `pr_created` | `{ repoId, prId, prTitle }` | PR detail page |
| `pr_merged` | `{ repoId, prId, prTitle }` | PR detail page |
| `pr_rejected` | `{ repoId, prId, prTitle }` | PR detail page |
| `member_removed` | `{ repoId, reason }` | Dashboard (no longer has access) |
| `role_changed` | `{ repoId, oldRole, newRole }` | Repo page |
