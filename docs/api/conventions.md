# API Conventions

Shared rules that apply to every endpoint in this API.

## Base URL

All routes are mounted under `/api` (see `src/app.ts`).

## Authentication

BitSync uses **HTTP-only cookies** for auth — clients do not handle tokens directly.

| Cookie | Purpose | Lifetime |
| --- | --- | --- |
| `access_token` | JWT, identifies the caller | short-lived (see `src/config/auth.config.ts`) |
| `refresh_token` | Opaque rotating token, used to mint new access tokens | long-lived |

The `authMiddleware` (`src/middlewares/auth.middleware.ts`) is applied to any route that needs an authenticated caller. Its behavior:

1. If a valid `access_token` is present → request continues.
2. If the access token is expired but a valid `refresh_token` is present → a new access + refresh token pair is issued (refresh-token rotation) and the request continues.
3. If a refresh token is **revoked and reused** within the grace window → treated as a concurrent retry (`401 Please retry`).
4. If a refresh token is **revoked and reused** past the grace window → treated as theft. All sessions for that user are revoked.
5. Otherwise → `401 Unauthorized`.

Clients should:
- Always send credentials (`fetch(..., { credentials: "include" })` / `axios({ withCredentials: true })`).
- On `401`, redirect the user to login.

## Authorization (repository routes)

Repo-scoped routes use a two-stage chain:

```
authMiddleware  →  repoContext  →  authorize(<permission>)  →  controller
```

- **`repoContext`** (`src/middlewares/repo.middleware.ts`) loads the repo by `:repoId`, loads the caller's membership, and attaches both to the request. Non-members get a 404 (existence is hidden).
- **`authorize(<permission>)`** (`src/middlewares/permission.middleware.ts`) checks the caller's role against a permission table.

Permission table (see `PERMISSIONS` in `src/middlewares/permission.middleware.ts`):

| Permission | owner | admin | member |
| --- | :---: | :---: | :---: |
| `repo:view` | ✓ | ✓ | ✓ |
| `repo:settings` | ✓ | ✓ |  |
| `repo:delete` | ✓ |  |  |
| `member:remove` | ✓ | ✓ |  |
| `member:promote` | ✓ | ✓ |  |
| `member:demote` | ✓ |  |  |

## Response envelope

All successful responses follow:

```json
{
  "status": "success",
  "message": "<optional human-readable message>",
  "data": { ... }
}
```

All error responses follow:

```json
{
  "status": "error",
  "message": "<human-readable error message>",
  "code": "<OPTIONAL_ERROR_CODE>"
}
```

The `code` field is only set for errors that need a programmatic discriminator (e.g. `EMAIL_NOT_VERIFIED`).

## Status codes

| Code | When |
| --- | --- |
| `200` | Successful read / mutation |
| `201` | Resource created |
| `302` | Redirect (used by `/auth/verify-email`) |
| `400` | Validation failed / malformed request (`BadRequestError`) |
| `401` | Not authenticated (`UnauthorizedError`) |
| `403` | Authenticated but not permitted (`ForbiddenError`) |
| `404` | Resource not found (or hidden from caller) (`NotFoundError`) |
| `409` | Conflict — duplicate username/email/repo name, duplicate invite (`ConflictError`) |
| `422` | Validation error with field details (`ValidationError`) |
| `500` | Unhandled server error |

Defined in `src/errors/app.error.ts`.

## Validation

Request bodies, query strings, and path params are validated with **Zod** schemas in `src/validators/`. On failure the controller throws a `BadRequestError` containing the first issue's message.
