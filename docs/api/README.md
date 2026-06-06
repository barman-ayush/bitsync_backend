# BitSync API Documentation

All endpoints are mounted under the `/api` prefix (see `src/app.ts`).

## Base URL

```
http://localhost:<PORT>/api
```

## Categories

| Category | Prefix | File |
| --- | --- | --- |
| Authentication | `/api/auth` | [auth.md](./auth.md) |
| Users | `/api/user` | [user.md](./user.md) |
| Repositories | `/api/repo` | [repo.md](./repo.md) |
| Invitations | `/api/invitation` | [invitation.md](./invitation.md) |

For shared conventions (auth flow, error envelope, status codes), see [conventions.md](./conventions.md).

## Quick index

### Authentication (`/api/auth`)
- `POST /register` — register a new user
- `GET /verify-email` — verify email via magic link
- `GET /send-email` — re-send verification email (auth required)
- `POST /login` — login with email + password
- `GET /logout` — clear session

### Users (`/api/user`)
- `GET /check-username/:username` — check if a username is free
- `GET /data` — current authenticated user (auth required)
- `GET /search/:username` — fuzzy-search users by username (auth required)
- `GET /search/repo/:username/:repoId` — search users who are NOT members of a repo (auth required)

### Repositories (`/api/repo`)
- `GET /` — search/list repositories the caller is a member of (auth required)
- `GET /check-name/:repoName` — check if a repo name is free under the caller (auth required)
- `POST /create` — create a new repository (auth required)
- `GET /:repoId` — fetch a single repository (auth + `repo:view`)
- `PUT /:repoId` — update a repository (auth + `repo:settings`)
- `POST /user/invite/:repoId` — invite a user (auth + `repo:settings`)
- `POST /user/remove/:repoId` — remove a member (auth + `member:remove`)
- `POST /user/promote/:repoId` — promote a member to admin (auth + `member:promote`)
- `POST /user/demote/:repoId` — demote an admin to member (auth + `member:demote`, owner-only)

### Invitations (`/api/invitation`)
- `POST /:id/accept` — accept an invitation (auth required)
- `POST /:id/reject` — reject an invitation (auth required)
- `DELETE /:id` — delete an invitation you sent (auth required)
