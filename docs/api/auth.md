# Authentication API

Routes mounted under `/api/auth` (see `src/routes/auth.routes.ts`).
Controller: `src/controllers/auth.controller.ts`.
Validators: `src/validators/auth.validator.ts`.

For shared conventions (auth cookies, error shape), see [conventions.md](./conventions.md).

---

## `POST /api/auth/register`

Register a new account. The user is created in an **unverified** state, and a verification email is sent. The user must verify their email before they can log in.

**Auth:** none.

### Request body

```json
{
  "email": "user@example.com",
  "username": "ayush",
  "password": "Str0ng!Password"
}
```

| Field | Rules |
| --- | --- |
| `email` | Required. Must contain exactly one `@` with non-empty local and domain parts. |
| `username` | Required. 1–39 chars. `[a-zA-Z0-9-]` only. Cannot start/end with `-` or contain `--`. Cannot be a reserved word (see `RESERVED_USERNAMES` in `src/validators/auth.validator.ts`). |
| `password` | Required. ≥ 8 chars, at least one uppercase, one lowercase, one digit, one special char. |

### Responses

**`200 OK`**

```json
{
  "status": "success",
  "message": "User registered successfully. Please check your email to verify.",
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "ayush",
    "displayName": "ayush",
    "avatarUrl": null,
    "emailVerified": false,
    "createdAt": "2026-05-28T10:00:00.000Z"
  }
}
```

**Errors**
- `400 BadRequest` — validation failure (returns first Zod issue message).
- `409 Conflict` — `"User with this email already exists."` or `"Username is already taken."`.

---

## `GET /api/auth/verify-email`

Consumes a one-time email-verification token. On success: marks the user as verified, issues access + refresh cookies, and **redirects** the user to the frontend. This is intended to be opened from an email link, not called by JS.

**Auth:** none (token in query string).

### Query parameters

| Param | Required | Description |
| --- | --- | --- |
| `token` | yes | The signed JWT delivered by the verification email. |

### Responses

- **`302 Redirect`** → `${feUrls.home}?toast="Welcome to BitSync"` on success. Sets `access_token` and `refresh_token` cookies.
- **`302 Redirect`** → `${feUrls.home}?toast="User already verified..."` if the user is already verified.

**Errors**
- `400 BadRequest` — `"Verification token is required."`
- `401 Unauthorized` — `"Invalid or expired verification link"`
- `404 NotFound` — `"User not found"`

---

## `GET /api/auth/send-email`

Re-send the email-verification link to the currently authenticated user.

**Auth:** required (`authMiddleware`).

### Responses

**`200 OK` (verified already)**

```json
{ "status": "success", "message": "Email is already verified." }
```

**`200 OK` (email sent)**

```json
{ "status": "success", "message": "Verification email sent." }
```

**Errors**
- `401 Unauthorized` — not authenticated.
- `404 NotFound` — `"User not found"`.

---

## `POST /api/auth/login`

Authenticate a user with email + password. On success, sets `access_token` and `refresh_token` cookies (HTTP-only) and returns the user profile.

**Auth:** none.

### Request body

```json
{
  "email": "user@example.com",
  "password": "Str0ng!Password"
}
```

| Field | Rules |
| --- | --- |
| `email` | Required, valid email shape. |
| `password` | Required, non-empty. |

### Responses

**`200 OK`** — sets `access_token` + `refresh_token` cookies.

```json
{
  "status": "success",
  "message": "Logged in successfully.",
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "ayush",
    "displayName": "ayush",
    "avatarUrl": null,
    "emailVerified": true,
    "createdAt": "2026-05-28T10:00:00.000Z"
  }
}
```

**Errors**
- `400 BadRequest` — validation failure, **or** account uses OAuth: `"This account uses OAuth. Login with Google/Microsoft or set a password in settings."`
- `401 Unauthorized` — `"Invalid email or password."`
- `403 Forbidden` — `"Email not verified. Verification email has been sent."` with `code: "EMAIL_NOT_VERIFIED"`. A new verification email is sent as a side effect.
- `404 NotFound` — `"No user with given email found."`

---

## `GET /api/auth/logout`

Revoke the current refresh token (if any) and clear both auth cookies.

**Auth:** none — it's safe to call even if the user is not authenticated. The endpoint always returns 200 to keep client logic simple.

### Responses

**`200 OK`** — clears `access_token` + `refresh_token` cookies.

```json
{ "status": "success", "message": "Logged Out successfully !!" }
```
