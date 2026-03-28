# 02 — RBAC (Role-Based Access Control) Spec

## Table of Contents

1. [Database Tables](#1-database-tables)
2. [Role Hierarchy](#2-role-hierarchy)
3. [Permission Definitions](#3-permission-definitions)
4. [Permission Resolution Algorithm](#4-permission-resolution-algorithm)
5. [Member Management Logic](#5-member-management-logic)
6. [Invitation System](#6-invitation-system)
7. [Middleware](#7-middleware)
8. [API Endpoints](#8-api-endpoints)

---

## 1. Database Tables

### 1.1 `repositories`

Each repository is private by default. One owner.

```sql
CREATE TABLE repositories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    head_commit_id  UUID,                          -- points to latest commit (FK added later)
    is_deleted      BOOLEAN DEFAULT FALSE,         -- soft delete
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (owner_id, name)                        -- no duplicate repo names per owner
);

CREATE INDEX idx_repos_owner ON repositories (owner_id);
```

### 1.2 `repo_members`

Maps users to repositories with roles. The OWNER is also stored here for uniform querying.

```sql
CREATE TYPE repo_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE repo_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id         UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            repo_role NOT NULL DEFAULT 'member',
    joined_at       TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (repo_id, user_id)
);

CREATE INDEX idx_repo_members_repo ON repo_members (repo_id);
CREATE INDEX idx_repo_members_user ON repo_members (user_id);
```

**Invariants:**
- Exactly ONE `owner` per repository (enforced at application level)
- When a repo is created, the creator is inserted as `owner` in the same transaction
- The `owner` row can never be deleted (only transferred — not supported yet)

### 1.3 `invitations`

In-app invitation system. Invites are scoped to a repo and sent by an owner/admin.

```sql
CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'declined', 'expired');

CREATE TABLE invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id         UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    inviter_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_id      UUID REFERENCES users(id) ON DELETE CASCADE,      -- NULL if invitee not yet registered
    invitee_email   VARCHAR(255) NOT NULL,                            -- always store email
    role            repo_role NOT NULL DEFAULT 'member',              -- role they'll get on accept
    status          invitation_status DEFAULT 'pending',
    expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    responded_at    TIMESTAMPTZ,

    UNIQUE (repo_id, invitee_email, status)                           -- one pending invite per email per repo
);

CREATE INDEX idx_invitations_invitee ON invitations (invitee_id) WHERE status = 'pending';
CREATE INDEX idx_invitations_email ON invitations (invitee_email) WHERE status = 'pending';
```

---

## 2. Role Hierarchy

```
OWNER  (exactly one per repo — highest privilege)
  │
  └── ADMIN  (can manage members, merge PRs)
        │
        └── MEMBER  (can view, edit, create PRs)
```

### Role Semantics

| Action | OWNER | ADMIN | MEMBER |
|--------|-------|-------|--------|
| View repository | Yes | Yes | Yes |
| Read content (blobs, trees, commits) | Yes | Yes | Yes |
| Write content (push to workspace) | Yes | Yes | Yes |
| Create workspace | Yes | Yes | Yes |
| Commit from workspace | Yes | Yes | Yes |
| Create pull requests | Yes | Yes | Yes |
| Review pull requests | Yes | Yes | Yes |
| **Merge / accept PRs** | **Yes** | **Yes** | **No** |
| **Reject PRs** | **Yes** | **Yes** | **No** |
| **Invite members** | **Yes** | **Yes** | **No** |
| **Remove members** | **Yes** | **Yes** (members only) | **No** |
| **Promote member → admin** | **Yes** | **No** | **No** |
| **Demote admin → member** | **Yes** | **No** | **No** |
| **Repository settings** | **Yes** | **Yes** | **No** |
| **Delete repository** | **Yes** | **No** | **No** |

---

## 3. Permission Definitions

Each action in the system maps to a permission string. Each permission lists which roles can perform it.

```javascript
const PERMISSIONS = {
    // Repository
    'repo:view':            ['owner', 'admin', 'member'],
    'repo:settings':        ['owner', 'admin'],
    'repo:delete':          ['owner'],

    // Content (blobs, trees, commits)
    'content:read':         ['owner', 'admin', 'member'],
    'content:write':        ['owner', 'admin', 'member'],

    // Workspaces
    'workspace:create':     ['owner', 'admin', 'member'],
    'workspace:commit':     ['owner', 'admin', 'member'],

    // Pull Requests
    'pr:create':            ['owner', 'admin', 'member'],
    'pr:review':            ['owner', 'admin', 'member'],
    'pr:merge':             ['owner', 'admin'],
    'pr:reject':            ['owner', 'admin'],

    // Member management
    'member:list':          ['owner', 'admin', 'member'],
    'member:invite':        ['owner', 'admin'],
    'member:remove':        ['owner', 'admin'],     // admin has constraints — see section 5
    'member:promote':       ['owner'],               // member → admin
    'member:demote':        ['owner'],               // admin → member
};
```

---

## 4. Permission Resolution Algorithm

```javascript
/**
 * Check if a user has a specific permission on a repository.
 *
 * @param {string} userId  - The authenticated user's ID
 * @param {string} repoId  - The repository being accessed
 * @param {string} permission - The permission string (e.g., 'pr:merge')
 * @returns {{ allowed: boolean, role: string }}
 * @throws {ForbiddenError | NotFoundError}
 */
async function checkPermission(userId, repoId, permission) {
    // 1. Get the user's membership in this repo
    const membership = await db.query(
        'SELECT role FROM repo_members WHERE user_id = $1 AND repo_id = $2',
        [userId, repoId]
    );

    // 2. No membership = no access (all repos are private)
    //    Return 404 (not 403) to avoid revealing repo existence
    if (!membership) {
        throw new NotFoundError('Repository not found');
    }

    const role = membership.role;

    // 3. Check if this role has the requested permission
    const allowedRoles = PERMISSIONS[permission];
    if (!allowedRoles) {
        throw new Error(`Unknown permission: ${permission}`);
    }

    if (!allowedRoles.includes(role)) {
        throw new ForbiddenError('Insufficient permissions');
    }

    return { allowed: true, role };
}
```

---

## 5. Member Management Logic

### 5.1 Invite Member

```
Input: actor (who is inviting), repo, invitee email, role to assign

Validate:
  1. Actor must have 'member:invite' permission (owner or admin)
  2. Cannot invite as 'owner' — ownership is not assignable
  3. If actor is admin → can only invite as 'member', NOT as 'admin'
  4. Invitee email must NOT already be a member of this repo
  5. No pending invitation must exist for this email + repo combo

Create invitation:
  6. Look up invitee email in users table
     → Found: set invitee_id on the invitation
     → Not found: leave invitee_id NULL (will be linked when they sign up)
  7. Insert invitation record (status = 'pending', expires in 7 days)

Notify:
  8. If invitee is a registered user → create in-app notification ('repo_invite')
  9. Send invitation email regardless (registered or not)
     Email contains: repo name, inviter name, accept/decline links
```

### 5.2 Accept Invitation

```
Input: authenticated user, invitation ID

Validate:
  1. Find invitation where id matches, status = 'pending', not expired
     → Not found or expired → error
  2. Verify the current user IS the invitee:
     - If invitation has invitee_id → must match current user's ID
     - Also verify current user's email matches invitation's invitee_email
     → Mismatch → error "This invitation is not for you"

Execute (in a single transaction):
  3. Update invitation: status = 'accepted', responded_at = now
  4. Insert into repo_members: (repo_id, user_id, role from invitation)

Notify:
  5. Send in-app notification to the inviter: "X accepted your invite"
```

### 5.3 Decline Invitation

```
Input: authenticated user, invitation ID

Validate:
  1. Same validation as accept — find pending invitation, verify invitee identity

Execute:
  2. Update invitation: status = 'declined', responded_at = now

Notify:
  3. Send in-app notification to the inviter: "X declined your invite"
```

### 5.4 Remove Member

```
Input: actor (who is removing), repo, target user to remove

Validate:
  1. Actor must be a member of the repo
  2. Target must be a member of the repo → not found → error
  3. Cannot remove yourself → error "Use leave repository instead"
  4. Cannot remove the owner → error

Permission check (who can remove whom):
  5. Actor is OWNER  → can remove anyone (admins and members)
  6. Actor is ADMIN  → can ONLY remove members
                     → trying to remove another admin → error "Admins can only remove members"
  7. Actor is MEMBER → cannot remove anyone → error

Execute:
  8. Delete the target's row from repo_members

Notify:
  9. Send in-app notification to removed user ('member_removed')
  10. Send email to removed user
```

### 5.5 Change Role (Promote / Demote)

```
Input: actor, repo, target user, new role

Validate:
  1. Actor must be the OWNER — only owner can change roles
     → Not owner → error "Only the repository owner can change roles"
  2. Cannot change your own role
  3. Cannot set new role to 'owner' — ownership transfer not supported
  4. Target must be a current member of the repo
  5. Target's current role must differ from new role → same role → error

Execute:
  6. Update repo_members: set role = new role for the target user

Notify:
  7. Send in-app notification to target user ('role_changed')
     Include: repo name, old role, new role
  8. Send email to target user
```

### 5.6 Create Repository

```
Input: authenticated user, repo name, description

Execute (in a single transaction):
  1. Insert into repositories (name, description, owner_id = current user)
  2. Insert into repo_members (repo_id, user_id, role = 'owner')
     The owner is always also a member — this allows uniform querying
     (e.g., "find all repos where user is a member" includes owned repos)

Return: the created repository
```

### 5.7 Delete Repository

```
Input: actor, repo

Validate:
  1. Actor must have 'repo:delete' permission (owner only)

Execute:
  2. Soft delete: set is_deleted = true on the repository
     (we don't hard-delete — allows recovery and keeps references intact)

Notify:
  3. Fetch all members of the repo (except the owner who deleted it)
  4. Send in-app notification to each ('member_removed', reason: 'repository_deleted')
  5. Send email to each member
```

### 5.8 Leave Repository

```
Input: authenticated user, repo

Validate:
  1. User must be a member of the repo
  2. User must NOT be the owner → error "Owner cannot leave the repository"
     (Owner must delete the repo or transfer ownership if we support that later)

Execute:
  3. Delete the user's row from repo_members

No notification needed (voluntary action).
```

---

## 7. Middleware

### Repo Context Middleware

Fetches the repository and the user's membership. Runs on all `/repos/:repoId/*` routes.

```javascript
async function repoContext(req, res, next) {
    const { repoId } = req.params;

    // Fetch repo
    const repo = await db.query(
        'SELECT * FROM repositories WHERE id = $1 AND is_deleted = FALSE',
        [repoId]
    );
    if (!repo) {
        return res.status(404).json({ error: 'Repository not found' });
    }

    // Fetch membership
    const membership = await db.query(
        'SELECT role FROM repo_members WHERE repo_id = $1 AND user_id = $2',
        [repoId, req.user.id]
    );
    if (!membership) {
        // 404, not 403 — don't reveal that the repo exists to non-members
        return res.status(404).json({ error: 'Repository not found' });
    }

    req.repo = repo;
    req.membership = membership;
    next();
}
```

### Permission Middleware (factory)

Takes a permission string, checks the user's role against it.

```javascript
function authorize(permission) {
    return (req, res, next) => {
        const allowedRoles = PERMISSIONS[permission];
        if (!allowedRoles || !allowedRoles.includes(req.membership.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}
```

### Middleware Chain for Repo Routes

```javascript
// Example: merge a PR — only owner and admin
router.post('/repos/:repoId/prs/:prId/merge',
    authenticate,          // verify JWT → req.user
    repoContext,           // fetch repo + membership → req.repo, req.membership
    authorize('pr:merge'), // check role has permission
    prController.merge     // handle request
);

// Example: view repo — any member
router.get('/repos/:repoId',
    authenticate,
    repoContext,
    authorize('repo:view'),
    repoController.get
);

// Example: invite member — owner and admin
router.post('/repos/:repoId/invitations',
    authenticate,
    repoContext,
    authorize('member:invite'),
    invitationController.create
);
```

---

## 8. API Endpoints

### Repositories

```
POST   /repos                            — create repository           [authenticated]
GET    /repos/:repoId                    — get repo details            [repo:view]
PATCH  /repos/:repoId                    — update repo settings        [repo:settings]
DELETE /repos/:repoId                    — soft delete repository      [repo:delete]
```

### Members

```
GET    /repos/:repoId/members            — list all members            [member:list]
DELETE /repos/:repoId/members/:userId    — remove a member             [member:remove]
PATCH  /repos/:repoId/members/:userId    — change role (promote/demote)[member:promote or member:demote]
POST   /repos/:repoId/leave              — leave repository            [any member, except owner]
```

### Invitations

```
POST   /repos/:repoId/invitations        — invite a user              [member:invite]
GET    /repos/:repoId/invitations         — list pending invites       [member:invite]
DELETE /repos/:repoId/invitations/:id     — cancel an invitation       [member:invite]
POST   /invitations/:id/accept            — accept invitation          [invitee only]
POST   /invitations/:id/decline           — decline invitation         [invitee only]
```
