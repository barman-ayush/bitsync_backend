# 02 — Role-Based Access Control (RBAC) Spec

This specification details the permission model and member management logic in BitSync.

## 1. Data Model

RBAC in BitSync is built on top of the User schema, adding the following tables:

### 1.1 Repositories
- `id` (UUID, Primary Key)
- `name` (string)
- `nameNormalized` (string, unique for the owner)
- `description` (string, nullable)
- `ownerId` (UUID, Foreign Key referencing Users)
- `headCommit` (string, nullable, references the latest commit hash)
- `isDeleted` (boolean, soft-deletion flag)
- `createdAt` & `updatedAt` (timestamps with timezone)

### 1.2 Repo Members
Maps users to repositories with specific roles:
- `id` (UUID, Primary Key)
- `repoId` (UUID, Foreign Key referencing Repositories)
- `userId` (UUID, Foreign Key referencing Users)
- `role` (enum: `'owner'`, `'admin'`, `'member'`)
- `joinedAt` (timestamp with timezone)
- `deletedAt` (timestamp with timezone, nullable, records soft-deletion/leave timestamps)

---

## 2. Role Hierarchy & Semantics

BitSync repositories are private by default. A repository has exactly one **Owner**, who is also represented in the members table to simplify membership lookups.

```
OWNER (highest privilege) ──> ADMIN ──> MEMBER
```

The action matrix across these roles is defined as follows:

| Action | OWNER | ADMIN | MEMBER |
| --- | :---: | :---: | :---: |
| View repository metadata & files | Yes | Yes | Yes |
| Push changes / Commit from workspace | Yes | Yes | Yes |
| Create workspaces & Pull Requests | Yes | Yes | Yes |
| Review Pull Requests | Yes | Yes | Yes |
| Merge or Close Pull Requests | **Yes** | **Yes** | **No** |
| Invite members | **Yes** | **Yes** (as members only) | **No** |
| Remove members | **Yes** | **Yes** (members only) | **No** |
| Promote members to Admin | **Yes** | **No** | **No** |
| Demote Admins to Member | **Yes** | **No** | **No** |
| Delete repository | **Yes** | **No** | **No** |

---

## 3. Permissions Map

Permissions are verified using a permission-to-role lookup map:

- **`repo:view`**: `owner`, `admin`, `member`
- **`repo:settings`**: `owner`, `admin`
- **`repo:delete`**: `owner`
- **`repo:push`**: `owner`, `admin`, `member` (required to push commits / upload blobs)
- **`member:invite`**: `owner`, `admin`
- **`member:remove`**: `owner`, `admin`
- **`member:promote`**: `owner`, `admin`
- **`member:demote`**: `owner`

---

## 4. Permission Resolution

Access control checks follow a structured chain:

1. **Authentication**: Evaluates request session cookies to identify the caller.
2. **Repository Access (`repoContext`)**: Verifies that the repository exists and is active. It checks if the caller is an active member of the repository. If not, a `404 Not Found` is returned (hiding repository existence).
3. **Role Checks (`authorize`)**: Resolves the user's membership role against the permission map required for the route. Insufficient roles yield a `403 Forbidden` error.

---

## 5. Member Management Logic

- **Inviting Members**: Admins and owners can invite users by email. Admins can only invite users as `member`, whereas the owner can invite users as `admin` or `member`. Invites are sent as `repo_invite` notifications.
- **Accepting/Declining Invites**: Consumes (deletes) the invite notification. Accepting joins (or rejoins) the user to the repository with the invited role and triggers a confirmation notification to the inviter.
- **Leaving Repositories**: Active members can voluntarily leave a repository (soft-deleting their membership). The repository owner cannot leave the repository (must transfer ownership or delete the repository instead).
- **Removing Members**: Admins can remove `member` users. Only the owner can remove `admin` users. The owner cannot be removed.
- **Promotions & Demotions**: The owner can promote a `member` to `admin`, or demote an `admin` to `member`.
- **Repository Deletion**: Soft-deletes the repository and marks all associated active memberships as deleted.
