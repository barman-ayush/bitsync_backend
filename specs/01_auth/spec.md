# 01 — Authentication Spec

> **Scope:** This spec covers email + password authentication only. OAuth (Google / Microsoft) login, account linking, and "set password for OAuth users" are deferred — see [`future-features.md`](./future-features.md).

## Table of Contents

1. [Database Tables](#1-database-tables)
2. [Cookie Strategy](#2-cookie-strategy)
3. [Token Types Explained](#3-token-types-explained)
4. [Authentication Flows](#4-authentication-flows)
5. [Auth Middleware (Server-Side Refresh)](#5-auth-middleware-server-side-refresh)
6. [API Endpoints](#6-api-endpoints)
7. [Rate Limiting](#7-rate-limiting)
8. [Cleanup Job](#8-cleanup-job)
9. [Security Considerations](#9-security-considerations)

---

## 1. Database Tables

### 1.1 `users`

Central identity table. Every user gets a row here regardless of signup method.

```sql
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    display_name    VARCHAR(100) NOT NULL,
    avatar_url      TEXT,
    password_hash   TEXT NOT NULL,
    email_verified  BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (email);
```

**Notes:**
- Every user has a `password_hash` — email + password is the only signup path in the MVP
- When OAuth lands (see [`future-features.md`](./future-features.md)), `password_hash` becomes nullable

### 1.2 `refresh_tokens`

Stores refresh tokens for session management. Only the SHA-256 hash is stored, never the plaintext token.

```sql
CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) NOT NULL UNIQUE,  -- SHA-256 hash of the refresh token
    device_info     VARCHAR(255),                  -- browser/device identifier (from User-Agent)
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked         BOOLEAN DEFAULT FALSE,
    revoked_at      TIMESTAMPTZ,                   -- when it was revoked (for theft detection grace period)
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens (token_hash);
CREATE INDEX idx_refresh_tokens_cleanup ON refresh_tokens (revoked, expires_at)
    WHERE revoked = TRUE OR expires_at < NOW();
```

**~300 bytes per row** (including indexes). At 100k users with 3 devices each = ~90 MB.

---

## 2. Cookie Strategy

**Both tokens are httpOnly cookies. JavaScript cannot read, modify, or delete either token.** The browser manages them automatically. The client sends `fetch(url, { credentials: 'include' })` and nothing else.

### Two Cookies Set on Login

```
Set-Cookie: access_token=<JWT>;
            HttpOnly;           ← JS cannot access
            Secure;             ← only sent over HTTPS
            SameSite=Strict;    ← only sent to same-origin requests
            Path=/;             ← sent with ALL requests
            Max-Age=900         ← 15 minutes

Set-Cookie: refresh_token=<random_hex_string>;
            HttpOnly;
            Secure;
            SameSite=Strict;
            Path=/;             ← sent with ALL requests (needed for server-side refresh)
            Max-Age=604800      ← 7 days
```

**Why both cookies have `Path=/`:** The auth middleware handles refresh server-side on ANY request. When a user hits `GET /repos/abc` with an expired access token, the middleware reads the refresh_token cookie from that same request, rotates tokens, and continues to the controller. If the refresh token had `Path=/auth/refresh`, the browser would NOT send it on `/repos/abc` and server-side refresh would be impossible.

### How It Works — The Client Does Nothing

```
Client code for ANY API call:

  fetch('/api/repos/abc', { credentials: 'include' })

That's it. No token management. No retry logic. No refresh calls.
The browser sends both cookies automatically.
The server handles everything.
```

---

## 3. Token Types Explained

### Access Token = JWT (self-validating)

```json
{
    "header": { "alg": "HS256", "typ": "JWT" },
    "payload": {
        "sub": "user-uuid",
        "email": "user@example.com",
        "name": "John Doe",
        "iat": 1711648200,
        "exp": 1711649100
    }
}
```

- Signed with server secret (`JWT_SECRET` env var)
- **15 minute expiry**
- Contains user identity, NOT roles (roles are per-repo, fetched per request)
- Validated by checking signature — no DB lookup needed
- Cannot be revoked (but expires quickly, so this is fine)

### Refresh Token = Random String (validated by DB)

```javascript
// Generation:
const refreshToken = crypto.randomBytes(64).toString('hex');
// → "a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5..."  (128 hex chars)

// Storage in DB (hash only):
const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
// → "9f86d081884c7d659a2feaa0c55ad015..."

// The random string goes in the cookie. The hash goes in the DB. They are NOT the same value.
```

- **NOT a JWT** — just a meaningless random string
- Validated by hashing and looking up the hash in DB
- **Can be revoked** (set `revoked=true` in DB)
- Single-use: each use revokes the old one and issues a new one (rotation)
- 7 day expiry
- If someone steals the DB, they get hashes — useless, can't reverse SHA-256

### Why the Refresh Token is Not a JWT

A JWT is self-validating (signature check, no DB needed). But the whole point of the refresh token is revocability, which requires DB. If you need DB anyway, a JWT adds nothing — a random string + DB lookup is simpler and smaller.

```
┌────────────────┬──────────────────────┬──────────────────────┐
│                │ Access Token         │ Refresh Token        │
├────────────────┼──────────────────────┼──────────────────────┤
│ Format         │ JWT                  │ Random hex string    │
│ Contains data? │ Yes (user id, email) │ No (meaningless)     │
│ Validated by   │ Signature check      │ DB hash lookup       │
│ Needs DB?      │ No                   │ Yes                  │
│ Revocable?     │ No (expires in 15m)  │ Yes (revoked in DB)  │
│ Size           │ ~300 bytes           │ 128 bytes            │
│ Stored in DB?  │ No                   │ Yes (as SHA-256 hash)│
└────────────────┴──────────────────────┴──────────────────────┘
```

---

## 4. Authentication Flows

### 4.1 Email + Password Signup

```
Client                          Server
  |                               |
  |  POST /auth/register          |
  |  { email, password, name }    |
  |  ─────────────────────────►   |
  |                               |  1. Validate email format, password strength
  |                               |  2. Check email not taken in users table
  |                               |  3. Hash password with bcrypt (cost=12)
  |                               |  4. Insert into users (email_verified=false, password_hash=hash)
  |                               |  5. Send verification email with signed token
  |                               |  6. Return { message: "Check your email" }
  |  ◄─────────────────────────   |
  |                               |
  |  GET /auth/verify-email?      |
  |      token=<signed_token>     |
  |  ─────────────────────────►   |
  |                               |  7. Verify token signature + expiry
  |                               |  8. Set email_verified = true
  |                               |  9. Check for pending invitations with this email
  |                               |     (link invitee_id, create notifications)
  |                               |  10. Generate access_token (JWT) + refresh_token (random)
  |                               |  11. Store SHA-256(refresh_token) in DB
  |                               |  12. Set both httpOnly cookies
  |  ◄─────────────────────────   |
  |  Set-Cookie: access_token     |
  |  Set-Cookie: refresh_token    |
```

### 4.2 Email + Password Login

```
Client                          Server
  |                               |
  |  POST /auth/login             |
  |  { email, password }          |
  |  ─────────────────────────►   |
  |                               |  1. Find user by email
  |                               |  2. Verify email_verified = true
  |                               |     (if not, send a new verification email
  |                               |      and redirect with a toast message)
  |                               |  3. bcrypt.compare(password, password_hash)
  |                               |  4. Generate access_token (JWT, 15min)
  |                               |  5. Generate refresh_token (random hex, 7days)
  |                               |  6. Store SHA-256(refresh_token) in refresh_tokens table
  |                               |  7. Set both httpOnly cookies
  |  ◄─────────────────────────   |
  |  Set-Cookie: access_token     |
  |  Set-Cookie: refresh_token    |
  |  Body: { user }               |  ← user profile only, NO tokens in body
```

### 4.3 Logout

```
Client                          Server
  |                               |
  |  POST /auth/logout            |
  |  Cookie: access_token=...;    |
  |          refresh_token=...    |  ← browser sends both automatically
  |  ─────────────────────────►   |
  |                               |  1. Read user from access_token cookie
  |                               |  2. Hash refresh_token cookie → find in DB
  |                               |  3. Set revoked=true, revoked_at=NOW() in DB
  |                               |  4. Clear BOTH cookies (Max-Age=0)
  |  ◄─────────────────────────   |
  |  Set-Cookie: access_token=;   |
  |              Max-Age=0;Path=/ |
  |  Set-Cookie: refresh_token=;  |
  |              Max-Age=0;Path=/ |
```

### 4.4 Forgot / Reset Password

```
POST /auth/forgot-password
{ email }

→ Find user by email
→ If user exists:
    Generate a password reset token (signed JWT, 1-hour expiry)
    Send email with reset link
→ Always return { message: "If the email exists, a reset link was sent" }
  (don't reveal whether email exists)

---

POST /auth/reset-password
{ token, new_password }

→ Verify token signature + expiry
→ Hash new password with bcrypt
→ UPDATE users SET password_hash = $hash
→ Revoke ALL refresh tokens for this user (force re-login everywhere)
→ Clear both cookies in response
→ Return success (user must log in again)
```

### 4.5 Page Refresh / New Tab

```
User refreshes the page or opens a new tab
  |
  ▼
Browser still has both cookies (they survive page refresh)
  |
  ▼
App makes any API call (e.g., GET /users/me)
  |
  ▼
Browser automatically sends Cookie: access_token=...; refresh_token=...
  |
  ▼
Auth middleware handles it:
  ├── access_token valid?     → proceed to controller, 200 response
  ├── access_token expired?   → middleware silently refreshes using refresh_token cookie
  │                             → new cookies set on the response alongside the data
  │                             → client never knows a refresh happened
  └── both invalid/missing?   → 401, redirect to login
```

---

## 5. Auth Middleware (Server-Side Refresh)

**The client NEVER handles token refresh.** The auth middleware does it transparently on any request.

### Flow

```
Request hits any protected route (e.g., GET /repos/abc)
  │
  ▼
Read access_token cookie
  │
  ├── No access_token AND no refresh_token → 401 "Not authenticated"
  │
  ├── access_token exists → jwt.verify()
  │     │
  │     ├── VALID → set req.user, call next(), done
  │     │
  │     ├── EXPIRED → fall through to refresh logic ↓
  │     │
  │     └── INVALID (tampered/malformed) → clear cookies, 401
  │
  ▼
Refresh logic (access_token expired or missing, refresh_token exists):
  │
  ├── 1. Read refresh_token from cookie
  ├── 2. Hash it → SHA-256
  ├── 3. Look up hash in DB
  │     │
  │     ├── NOT FOUND → clear cookies, 401 "Invalid session"
  │     │
  │     ├── FOUND but REVOKED:
  │     │     Check revoked_at timestamp
  │     │     │
  │     │     ├── Revoked < 10 seconds ago → likely concurrent request, not theft
  │     │     │   → 401 "Please retry" (client retries, gets fresh cookie from the other request)
  │     │     │
  │     │     └── Revoked > 10 seconds ago → THEFT DETECTED
  │     │         → Revoke ALL tokens for this user
  │     │         → Clear cookies
  │     │         → 401 "Session compromised, all sessions revoked"
  │     │
  │     ├── FOUND but EXPIRED → clear cookies, 401 "Session expired"
  │     │
  │     └── FOUND, VALID, NOT REVOKED → proceed ↓
  │
  ├── 4. Revoke old refresh token (SET revoked=true, revoked_at=NOW())
  ├── 5. Fetch user from DB (SELECT id, email, display_name FROM users WHERE id = stored.user_id)
  ├── 6. Generate new access_token (JWT, 15 min)
  ├── 7. Generate new refresh_token (random hex string)
  ├── 8. Store SHA-256(new refresh_token) in DB
  ├── 9. Set both new cookies on res (they'll be sent with the controller's response)
  ├── 10. Set req.user = { id, email, name }
  └── 11. Call next() → controller runs normally
          │
          ▼
      Controller sends response (e.g., { repo data })
      Response includes BOTH the data AND the new Set-Cookie headers
      Client receives data + updated cookies in a single response
```

### What the Client Sees

```
Scenario 1: Access token still valid
  Client sends:   GET /repos/abc  (cookies sent automatically)
  Client receives: 200 { repo data }
  (no cookie changes)

Scenario 2: Access token expired, refresh succeeds (TRANSPARENT)
  Client sends:   GET /repos/abc  (cookies sent automatically)
  Client receives: 200 { repo data }  ← same as above, client can't tell the difference
                   + Set-Cookie: access_token=<NEW>
                   + Set-Cookie: refresh_token=<NEW>
  (browser silently updates cookies)

Scenario 3: Both tokens invalid
  Client sends:   GET /repos/abc
  Client receives: 401 { error: "Session expired" }
  (client redirects to /login)
```

**The client treats every request the same.** It never checks tokens, never calls refresh, never retries. It just sends `fetch(url, { credentials: 'include' })` and handles 401 by redirecting to login.

### Concurrent Request Handling

```
Problem:
  Tab 1: GET /repos/abc  (access_token expired, refresh_token = "abc123")
  Tab 2: GET /repos/xyz  (access_token expired, refresh_token = "abc123")
  Both sent at the same time.

  Tab 1 hits middleware → refresh succeeds → "abc123" is revoked → new cookies issued
  Tab 2 hits middleware → tries "abc123" → IT'S REVOKED!

  Without grace period: Tab 2 thinks it's theft → revokes ALL sessions → logs user out

Solution:
  Check revoked_at timestamp. If revoked < 10 seconds ago → concurrent request, not theft.
  Tab 2 gets 401 "Please retry" → client retries → now has Tab 1's new cookies → works.
```

### Public Routes (skip auth middleware)

```
POST /auth/register
POST /auth/login
GET  /auth/verify-email
POST /auth/forgot-password
POST /auth/reset-password
```

---

## 6. API Endpoints

### API Endpoints (JSON responses — called by frontend JS)

```
POST   /auth/register                    — email + password signup
POST   /auth/login                       — email + password login → sets cookies
POST   /auth/logout                      — revoke tokens → clears cookies
POST   /auth/forgot-password             — send password reset email
POST   /auth/reset-password              — reset password → clears cookies (force re-login)

GET    /users/me                         — get current user profile [authenticated]
PATCH  /users/me                         — update profile (name, avatar) [authenticated]
GET    /users/me/repos                   — list repos user is member of [authenticated]
GET    /users/me/sessions                — list active sessions [authenticated]
DELETE /users/me/sessions/:id            — revoke a specific session [authenticated]
```

### Page Navigation Endpoints (browser navigates to these — NOT called by JS)

These are full page navigations triggered by `<a href="...">` links or `window.location`. The browser loads these URLs directly. The backend responds with 302 redirects, never JSON.

```
GET    /auth/verify-email?token=xxx      — verify email → sets cookies → 302 to /dashboard
```

**No `/auth/refresh` endpoint.** Token refresh is handled transparently by the auth middleware on every protected route.

---

## 7. Rate Limiting

```
| Endpoint Category       | Limit              | Window | Key        |
|-------------------------|--------------------|--------|------------|
| Auth (login/register)   | 10 requests        | 1 min  | IP         |
| Auth (forgot-password)  | 3 requests         | 1 min  | IP         |
| API (authenticated)     | 100 requests       | 1 min  | User ID    |
| File uploads            | 20 requests        | 1 min  | User ID    |
```

---

## 8. Cleanup Job

Revoked and expired refresh tokens accumulate in the DB over time. A scheduled job cleans them up.

### What Gets Cleaned Up

A scheduled job (e.g. daily at 3:00 AM) deletes refresh token rows where `created_at` is older than 30 days **and** the token is either revoked or past its `expires_at`. Active tokens are never touched.

### Why 30 Days (Not Immediately)

- **Audit trail**: If a user reports suspicious activity, you can check when/where tokens were revoked
- **Theft investigation**: The `revoked_at` timestamps show the exact sequence of events
- **Concurrent request grace period**: Freshly revoked tokens (< 10 sec) are still referenced by the middleware
- After 30 days, tokens have no forensic or operational value → safe to delete

### Expected Impact

```
Without cleanup (1 year, 10k users, 2 devices, refreshing every 15 min):
  10,000 users × 2 devices × 96 refreshes/day × 365 days = ~700 million rows
  ~700M × 300 bytes = ~210 GB  ← problem

With daily cleanup (30-day retention):
  Active tokens: 10,000 × 2 = 20,000 rows
  Revoked (30 day window): ~96 × 30 × 20,000 = ~57.6M rows
  ~57.6M × 300 bytes = ~17 GB  ← manageable

  In practice much less, because most revoked tokens are from rotation
  and the 30-day window is a ceiling, not typical usage.
```

---

## 9. Security Considerations

### Password Storage
- **bcrypt** with cost factor 12
- Never log or return passwords/hashes in API responses
- Minimum requirements: 8 characters, checked against common passwords list (top 10k)

### Cookie Security
- Both tokens in **httpOnly** cookies — JS cannot read, modify, or steal either
- **Secure** flag — cookies only sent over HTTPS
- **SameSite=Strict** — cookies NOT sent on cross-origin requests (prevents CSRF)
- No tokens in response bodies, localStorage, sessionStorage, or JS variables
- Cookies cleared on logout, password reset, and session compromise

### Token Security
- Access tokens: short-lived (15 min), self-validating (JWT), not stored in DB
- Refresh tokens: random strings, stored as SHA-256 hash in DB, single-use with rotation
- Refresh token reuse detection: revoked token reused after 10s grace period → revoke ALL user sessions

### API Security
- All endpoints over HTTPS (required for Secure cookies)
- CORS configured for specific frontend origin only, with `credentials: true` (required for cross-origin cookies)
- Helmet.js for security headers (X-Frame-Options, CSP, HSTS, etc.)
- Input validation on all endpoints (zod schemas)
- SQL injection prevented by parameterized queries (never string concat)

### Session Management
- On password change → revoke ALL refresh tokens → clear cookies (force re-login everywhere)
- On account deletion → revoke all tokens, remove all memberships, clear cookies
- Sessions page: user can see active sessions (device_info) and revoke individually

### Email Security
- Verification emails: signed JWT, 24-hour expiry
- Password reset emails: signed JWT, 1-hour expiry
- Rate limit email sends (1 per minute per email)
- Never reveal whether an email exists in forgot-password responses
