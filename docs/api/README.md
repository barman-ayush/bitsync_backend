# BitSync API Documentation

All endpoints are mounted under the `/api` prefix (see `src/app.ts`).

## Base URL

```
http://localhost:<PORT>/api
```

## Categories

| Category | Prefix | Documentation File |
| --- | --- | --- |
| Authentication | `/api/auth` | [auth.md](./auth.md) |
| Users | `/api/user` | [user.md](./user.md) |
| Repositories | `/api/repo` | [repo.md](./repo.md) |
| Workspaces | `/api/workspace` | [workspace.md](./workspace.md) |
| Commits | `/api/commit` | [commit.md](./commit.md) |
| Pull Requests | `/api/pr` | [pr.md](./pr.md) |
| Notifications | `/api/notification` | [notification.md](./notification.md) |

For shared conventions (auth flow, error envelope, status codes), see [conventions.md](./conventions.md).

## Quick Index

### Authentication (`/api/auth`)
- `POST /register` — Register a new user
- `GET /verify-email` — Verify email via Magic Link token
- `GET /send-email` — Re-send verification email (auth required)
- `POST /login` — Login with email + password
- `GET /logout` — Logout and clear sessions

### Users (`/api/user`)
- `GET /check-username/:username` — Check if a username is available
- `GET /data` — Fetch current user details (auth required)
- `GET /search/:username` — Search users by username (auth required)
- `GET /search/repo/:username/:repoId` — Search non-member users for repo invite (auth required)
- `PATCH /update` — Update user display name and/or avatar blob (auth required)
- `GET /:username` — Fetch user public profile and common repositories (auth required)

### Repositories (`/api/repo`)
- `GET /` — Search & list repositories user is a member of (auth required)
- `GET /check-name/:repoName` — Check name availability under current user (auth required)
- `POST /create` — Create a new repository (auth required)
- `POST /invite/accept` — Accept repository invitation (auth required)
- `POST /invite/decline` — Decline repository invitation (auth required)
- `GET /:repoId/contributors` — List repository contributors (auth + repo:view)
- `GET /:repoId/reviewers/search` — Search contributors for reviewing (auth + repo:view)
- `POST /:repoId/invite` — Invite users to repository (auth + member:invite)
- `POST /:repoId/leave` — Leave repository (auth required)
- `POST /:repoId/remove` — Remove user from repository (auth + member:remove)
- `POST /:repoId/promote` — Promote member to admin (auth + member:promote)
- `POST /:repoId/demote` — Demote admin to member (auth + member:demote)
- `GET /get-data/:repoId` — Fetch files & folders tree of repo main HEAD (auth + repo:view)
- `GET /:username/:reponame` — Show repository page by slug (auth + repo:view)

### Workspaces (`/api/workspace`)
- `POST /create/:repoId/:name` — Create a new workspace (auth + repo:view)
- `GET /get-all/:repoId` — List workspaces user has in repo (auth + repo:view)
- `GET /check/:repoId/:workspaceName` — Check workspace name availability (auth + repo:view)
- `GET /status/:repoId/:workspaceId` — Check uncommitted status of workspace (auth + repo:view)
- `GET /tree/get/:repoId/:workspaceId` — Fetch files/folders tree for workspace (auth + repo:view)
- `POST /blob/:repoId` — Upload raw file content (auth + repo:push)
- `GET /blob/:repoId/:blobHash` — Get signed Cloudinary download URL for a file blob (auth + repo:view)
- `POST /tree/upload/:repoId/:workspaceId` — Upload/register uncommitted workspace changes (auth + repo:push)

### Commits (`/api/commit`)
- `POST /:repoId/:workspaceId` — Bake uncommitted changes into a new commit (auth + repo:push)
- `GET /history/:repoId/:workspaceId` — Fetch commit history since fork point (auth + repo:view)

### Pull Requests (`/api/pr`)
- `GET /commit-trail/:repoId/:workspaceId{/:prId}` — Fetch commit trail of a workspace/PR (auth + repo:view)
- `GET /status/:repoId/:workspaceId` — Check PR capability status (CREATE_PR/VIEW_PR) (auth + repo:view)
- `POST /create/:repoId/:workspaceId` — Create a new pull request (auth + repo:push)
- `GET /mergeability/:repoId/:workspaceId/:prId` — Check if PR can be merged without conflict (auth + repo:view)
- `GET /list/:repoId` — List all pull requests of a repository (auth + repo:view)
- `GET /details/:repoId/:prId` — Fetch details of a single pull request (auth + repo:view)
- `GET /commit-changes/:repoId/:workspaceId` — Fetch PR commit changes after latest merge (auth + repo:view)
- `POST /close/:repoId/:prId` — Close a pull request (auth + repo:view)
- `GET /assigned-reviews/:repoId` — Fetch reviews assigned to user (auth + repo:view)
- `GET /review-view/:repoId/:workspaceId/:prId` — Fetch workspace details for reviewer (auth + repo:view)
- `GET /changes-view/:repoId/:workspaceId/:prId` — Fetch PR changes & conflict files list (auth + repo:view)
- `GET /reviews/:repoId/:prId` — List reviews submitted on a PR (auth + repo:view)
- `POST /resolve-conflicts/:repoId/:prId` — Apply conflict resolution decisions (auth + repo:push)
- `POST /merge/:repoId/:prId` — Merge a pull request into repo HEAD (auth + repo:push)
- `POST /add-reviewers/:repoId/:prId` — Add reviewers to a PR (auth + repo:push)
- `POST /submit-review/:repoId/:prId` — Submit review approval/changes request (auth + repo:view)
- `GET /review-status/:repoId/:prId` — Fetch PR approval review status (auth + repo:view)
- `POST /comment/:repoId/:prId` — Add comment on PR or file line (auth + repo:view)
- `DELETE /comment/:repoId/:prId/:commentId` — Delete a comment (auth + repo:view)

### Notifications (`/api/notification`)
- `GET /` — Fetch notifications inbox for the current user (auth required)
- `PATCH /read-all` — Mark all notifications as read (auth required)
- `PATCH /:notificationId/read` — Mark a single notification as read (auth required)
