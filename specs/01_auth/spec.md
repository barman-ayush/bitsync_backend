# 01 — Authentication Spec

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
    password_hash   TEXT,                          -- NULL if user signed up via OAuth only
    email_verified  BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (email);
```

**Notes:**
- `password_hash` is NULL when the user signed up via OAuth and hasn't set a password
- If `password_hash` is NOT NULL → user can log in with email + password
- No `auth_provider` column — the presence of `password_hash` and rows in `user_oauth_links` determine available login methods

### 1.2 `user_oauth_links`

Allows a single user to link multiple OAuth providers to their account.

```sql
CREATE TABLE user_oauth_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        VARCHAR(20) NOT NULL,          -- 'google' | 'microsoft'
    provider_id     VARCHAR(255) NOT NULL,         -- provider's unique user ID
    provider_email  VARCHAR(255),                  -- email from the provider
    access_token    TEXT,                           -- encrypted OAuth access token (AES-256)
    refresh_token   TEXT,                           -- encrypted OAuth refresh token (AES-256)
    token_expires   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (provider, provider_id)
);

CREATE INDEX idx_oauth_links_user ON user_oauth_links (user_id);
```

**How login resolution works:**
- Email + password login → find user by email, verify `password_hash`
- OAuth login → find `user_oauth_links` row by `(provider, provider_id)` → get `user_id`
- If OAuth login but no link exists → check if email matches existing user → link automatically, or create new user

### 1.3 `refresh_tokens`

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
  |                               |  2. If user.password_hash is NULL → error:
  |                               |     "This account uses OAuth. Login with Google/Microsoft
  |                               |      or set a password in settings."
  |                               |  3. Verify email_verified = true
  |                               |  4. bcrypt.compare(password, password_hash)
  |                               |  5. Generate access_token (JWT, 15min)
  |                               |  6. Generate refresh_token (random hex, 7days)
  |                               |  7. Store SHA-256(refresh_token) in refresh_tokens table
  |                               |  8. Set both httpOnly cookies
  |  ◄─────────────────────────   |
  |  Set-Cookie: access_token     |
  |  Set-Cookie: refresh_token    |
  |  Body: { user }               |  ← user profile only, NO tokens in body
```

### 4.3 OAuth Flow (Google / Microsoft)

**Entirely backend-controlled.** The client only triggers a page navigation. Every redirect, callback, error handling, and final landing is decided by the backend. The client has zero logic for OAuth.

**Client triggers OAuth by navigating the page (not an API call):**
```html
<!-- Login page button — just a link, not a fetch() -->
<a href="/auth/oauth/google">Sign in with Google</a>
```

```
Browser                         Server                        Google
  |                               |                               |
  | User clicks "Sign in          |                               |
  | with Google" link             |                               |
  |                               |                               |
  | ① Browser navigates to        |                               |
  |    /auth/oauth/google         |                               |
  |  ─────────────────────────►   |                               |
  |                               |  1. Generate state parameter   |
  |                               |     (random string for CSRF)  |
  |                               |  2. Generate PKCE code_verifier|
  |                               |     + code_challenge           |
  |                               |  3. Store state + code_verifier|
  |                               |     in a short-lived httpOnly  |
  |                               |     cookie (5 min expiry)     |
  |                               |  4. Build Google auth URL with:|
  |                               |     - client_id               |
  |                               |     - redirect_uri = /auth/oauth/google/callback |
  |                               |     - scope = openid email profile |
  |                               |     - state = <generated>     |
  |                               |     - code_challenge           |
  |                               |                               |
  | ② Backend redirects browser   |                               |
  |    to Google's login page     |                               |
  |  ◄── 302 Location: https://   |                               |
  |       accounts.google.com/    |                               |
  |       o/oauth2/auth?...       |                               |
  |  Set-Cookie: oauth_state=...  |                               |
  |                               |                               |
  | ③ Browser is now on Google    |                               |
  |    User logs in / consents    |                               |
  |  ────────────────────────────────────────────────────────►    |
  |                               |                               |
  | ④ Google redirects browser    |                               |
  |    back to our callback       |                               |
  |  ◄──────────────────────────────── 302 Location:              |
  |       /auth/oauth/google/     |    /auth/oauth/google/callback|
  |       callback?code=xxx       |    ?code=xxx&state=yyy        |
  |       &state=yyy              |                               |
  |                               |                               |
  | ⑤ Browser hits our callback   |                               |
  |    endpoint (backend)         |                               |
  |  ─────────────────────────►   |                               |
  |  Cookie: oauth_state=...      |                               |
  |                               |  5. Read state from cookie     |
  |                               |     Compare with ?state param  |
  |                               |     → mismatch? redirect to    |
  |                               |       /login?error=oauth_failed|
  |                               |                               |
  |                               |  6. Exchange code for tokens   |
  |                               |     POST to Google token endpoint |
  |                               |     with code + code_verifier  |
  |                               |     ──────────────────────►   |
  |                               |     ◄── { access_token,       |
  |                               |           id_token }          |
  |                               |                               |
  |                               |  7. Fetch user profile from    |
  |                               |     Google (or decode id_token)|
  |                               |     → email, name, avatar,    |
  |                               |       provider_id             |
  |                               |                               |
  |                               |  8. Find or create user:       |
  |                               |     a. Check user_oauth_links  |
  |                               |        for (google, provider_id)|
  |                               |     b. Found → existing user   |
  |                               |        → get user_id           |
  |                               |     c. Not found:              |
  |                               |        - Check users table for |
  |                               |          same email            |
  |                               |        - Email exists? → link  |
  |                               |          OAuth to existing user|
  |                               |        - New email? → create   |
  |                               |          user + oauth_link     |
  |                               |        - Set email_verified=   |
  |                               |          true (Google verified)|
  |                               |                               |
  |                               |  9. Store/update Google tokens |
  |                               |     (encrypted) in             |
  |                               |     user_oauth_links           |
  |                               |                               |
  |                               |  10. Check pending invitations |
  |                               |      for this email            |
  |                               |                               |
  |                               |  11. Generate access_token +   |
  |                               |      refresh_token             |
  |                               |      Store refresh hash in DB  |
  |                               |                               |
  |                               |  12. Clear oauth_state cookie  |
  |                               |      Set auth cookies          |
  |                               |      Redirect to app           |
  |                               |                               |
  | ⑥ Backend redirects browser   |                               |
  |    to the app (final landing) |                               |
  |  ◄── 302 Location: /dashboard |                               |
  |  Set-Cookie: access_token=... |                               |
  |  Set-Cookie: refresh_token=...|                               |
  |  Set-Cookie: oauth_state=;    |  ← clear the oauth state cookie
  |              Max-Age=0         |                               |
  |                               |                               |
  | ⑦ Browser loads /dashboard    |                               |
  |    with auth cookies set.     |                               |
  |    User is logged in.         |                               |
```

**Key points:**
- The client's page changes 4 times: our login → Google → our callback → our dashboard. All via 302 redirects. No JavaScript involved.
- The callback endpoint (`/auth/oauth/google/callback`) is a **backend endpoint** that the browser hits directly. It is NOT an API endpoint called by frontend JS.
- On success → backend redirects to `/dashboard` (or whatever page we define)
- On error → backend redirects to `/login?error=<error_code>`

**Error handling — backend decides where to redirect:**

```
Callback endpoint error scenarios:

| Error                          | Backend redirects to                     |
|--------------------------------|------------------------------------------|
| State mismatch (CSRF)          | /login?error=oauth_failed                |
| Google token exchange fails    | /login?error=oauth_failed                |
| Google account linked to       | /login?error=account_already_linked      |
| another BitSync user           |                                          |
| User's email not verified      | /login?error=email_not_verified          |
| Any unexpected error           | /login?error=oauth_failed                |
| Success                        | /dashboard                               |
```

The frontend login page reads the `?error` query param and shows the appropriate error message. That's the only client-side logic.

**Backend callback implementation:**

```javascript
router.get('/auth/oauth/google/callback', async (req, res) => {
    try {
        const { code, state } = req.query;
        const storedState = req.cookies.oauth_state;

        // 1. Verify state (CSRF protection)
        if (!state || !storedState || state !== JSON.parse(storedState).state) {
            return res.redirect('/login?error=oauth_failed');
        }

        // 2. Exchange code for tokens
        const codeVerifier = JSON.parse(storedState).codeVerifier;
        const googleTokens = await exchangeCodeForTokens(code, codeVerifier);

        // 3. Get user profile
        const googleUser = await getGoogleUserProfile(googleTokens.access_token);

        // 4. Find or create user
        let user;
        const existingLink = await db.query(
            'SELECT user_id FROM user_oauth_links WHERE provider = $1 AND provider_id = $2',
            ['google', googleUser.id]
        );

        if (existingLink) {
            user = await db.query('SELECT * FROM users WHERE id = $1', [existingLink.user_id]);
        } else {
            const existingUser = await db.query('SELECT * FROM users WHERE email = $1', [googleUser.email]);
            if (existingUser) {
                user = existingUser;
            } else {
                user = await db.query(
                    'INSERT INTO users (email, display_name, avatar_url, email_verified) VALUES ($1, $2, $3, true) RETURNING *',
                    [googleUser.email, googleUser.name, googleUser.picture]
                );
            }
            // Link OAuth
            await db.query(
                'INSERT INTO user_oauth_links (user_id, provider, provider_id, provider_email, access_token, refresh_token, token_expires) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [user.id, 'google', googleUser.id, googleUser.email,
                 encrypt(googleTokens.access_token), encrypt(googleTokens.refresh_token), googleTokens.expires_at]
            );
        }

        // 5. Check pending invitations
        await linkPendingInvitations(user.id, user.email);

        // 6. Generate auth tokens + set cookies
        const accessToken = generateAccessToken(user);
        const refreshToken = crypto.randomBytes(64).toString('hex');
        await storeRefreshToken(user.id, refreshToken, req.headers['user-agent']);

        setAuthCookies(res, accessToken, refreshToken);

        // 7. Clear oauth state cookie
        res.cookie('oauth_state', '', { httpOnly: true, maxAge: 0, path: '/' });

        // 8. Redirect to app — backend decides the destination
        return res.redirect('/dashboard');

    } catch (err) {
        console.error('OAuth callback error:', err);
        res.cookie('oauth_state', '', { httpOnly: true, maxAge: 0, path: '/' });
        return res.redirect('/login?error=oauth_failed');
    }
});
```

### 4.4 Logout

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

### 4.5 Linking OAuth to Existing Account (Settings Page)

**Same backend-controlled pattern.** User clicks a link, backend handles everything, backend decides where to redirect.

**Client triggers link by navigating (not an API call):**
```html
<!-- Settings page — just a link -->
<a href="/auth/link/google">Link Google Account</a>
```

```
Browser                         Server                        Google
  |                               |                               |
  | User clicks "Link Google      |                               |
  | Account" on settings page     |                               |
  |                               |                               |
  | ① Browser navigates to        |                               |
  |    /auth/link/google          |                               |
  |  ─────────────────────────►   |                               |
  |  Cookie: access_token=...     |                               |
  |                               |  1. Read user from access_token|
  |                               |     cookie (must be logged in) |
  |                               |     → not logged in? redirect  |
  |                               |       to /login                |
  |                               |  2. Generate state (includes   |
  |                               |     user_id + action="link")  |
  |                               |     + PKCE code_verifier       |
  |                               |  3. Store in oauth_state cookie|
  |                               |                               |
  | ② Backend redirects to Google |                               |
  |  ◄── 302 Location: Google     |                               |
  |  Set-Cookie: oauth_state=...  |                               |
  |                               |                               |
  | ③ User logs in at Google      |                               |
  |  ────────────────────────────────────────────────────────►    |
  |                               |                               |
  | ④ Google redirects to our     |                               |
  |    link callback              |                               |
  |  ◄──────────────────────────────── 302 to                     |
  |                               |    /auth/link/google/callback  |
  |                               |    ?code=xxx&state=yyy         |
  |                               |                               |
  | ⑤ Browser hits callback       |                               |
  |  ─────────────────────────►   |                               |
  |  Cookie: oauth_state=...;     |                               |
  |          access_token=...     |                               |
  |                               |  4. Verify state               |
  |                               |  5. Verify user is still       |
  |                               |     logged in (access_token)   |
  |                               |  6. Exchange code for tokens   |
  |                               |  7. Fetch Google profile       |
  |                               |  8. Check: is this Google      |
  |                               |     account already linked to  |
  |                               |     ANOTHER BitSync user?      |
  |                               |     → Yes: redirect to         |
  |                               |       /settings?error=         |
  |                               |       account_already_linked   |
  |                               |     → No: insert into          |
  |                               |       user_oauth_links for     |
  |                               |       current user             |
  |                               |  9. Clear oauth_state cookie   |
  |                               |                               |
  | ⑥ Backend redirects to        |                               |
  |    settings page              |                               |
  |  ◄── 302 Location:            |                               |
  |       /settings?linked=google |                               |
  |                               |                               |
  | ⑦ Browser loads settings page |                               |
  |    Shows "Google linked        |                               |
  |    successfully"              |                               |
```

**Error handling — backend redirects:**

```
| Error                          | Backend redirects to                     |
|--------------------------------|------------------------------------------|
| Not logged in                  | /login                                   |
| State mismatch                 | /settings?error=link_failed              |
| Google account already linked  | /settings?error=account_already_linked   |
| to another user                |                                          |
| Token exchange fails           | /settings?error=link_failed              |
| Success                        | /settings?linked=google                  |
```

### 4.6 Setting a Password (for OAuth-only users)

```
POST /auth/set-password
{ new_password }
Cookie: access_token=...            ← browser sends automatically

→ Read user from access_token cookie
→ Validate password strength
→ Hash with bcrypt
→ UPDATE users SET password_hash = $hash WHERE id = $user_id
→ Now user can log in with email + password too
```

### 4.7 Forgot / Reset Password

```
POST /auth/forgot-password
{ email }

→ Find user by email
→ If user exists AND password_hash is NOT NULL:
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

### 4.8 Page Refresh / New Tab

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

### Implementation

```javascript
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

async function authenticate(req, res, next) {
    const accessToken = req.cookies.access_token;
    const refreshToken = req.cookies.refresh_token;

    // ── No tokens at all → not logged in ──
    if (!accessToken && !refreshToken) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    // ── Try access token first ──
    if (accessToken) {
        try {
            const payload = jwt.verify(accessToken, process.env.JWT_SECRET);
            req.user = { id: payload.sub, email: payload.email, name: payload.name };
            return next();  // ✓ access token valid, no refresh needed
        } catch (err) {
            if (err.name !== 'TokenExpiredError') {
                // Tampered or malformed — not just expired
                clearAuthCookies(res);
                return res.status(401).json({ error: 'Invalid token' });
            }
            // Expired → fall through to refresh logic
        }
    }

    // ── Access token expired (or missing) → try server-side refresh ──
    if (!refreshToken) {
        clearAuthCookies(res);
        return res.status(401).json({ error: 'Session expired, please log in again' });
    }

    try {
        // 1. Hash the refresh token from the cookie
        const tokenHash = crypto
            .createHash('sha256')
            .update(refreshToken)
            .digest('hex');

        // 2. Look up in DB
        const stored = await db.query(
            'SELECT * FROM refresh_tokens WHERE token_hash = $1',
            [tokenHash]
        );

        // 3. Not found
        if (!stored) {
            clearAuthCookies(res);
            return res.status(401).json({ error: 'Invalid session' });
        }

        // 4. Already revoked → possible theft
        if (stored.revoked) {
            const revokedAgo = Date.now() - new Date(stored.revoked_at).getTime();

            if (revokedAgo < 10_000) {
                // Revoked less than 10 seconds ago → likely a concurrent request
                // The other request already issued new tokens
                // This request just needs to retry (client will have new cookies by then)
                return res.status(401).json({
                    error: 'Session refreshed by another request, please retry'
                });
            }

            // Revoked more than 10 seconds ago → real theft
            await db.query(
                'UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE user_id = $1 AND revoked = FALSE',
                [stored.user_id]
            );
            clearAuthCookies(res);
            return res.status(401).json({
                error: 'Session compromised. All sessions have been revoked. Please log in again.'
            });
        }

        // 5. Expired
        if (new Date(stored.expires_at) < new Date()) {
            clearAuthCookies(res);
            return res.status(401).json({ error: 'Session expired, please log in again' });
        }

        // 6. VALID — rotate tokens

        // Revoke the old refresh token
        await db.query(
            'UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE id = $1',
            [stored.id]
        );

        // Fetch user info for new JWT
        const user = await db.query(
            'SELECT id, email, display_name FROM users WHERE id = $1',
            [stored.user_id]
        );

        if (!user) {
            clearAuthCookies(res);
            return res.status(401).json({ error: 'User not found' });
        }

        // Generate new access token (JWT)
        const newAccessToken = jwt.sign(
            { sub: user.id, email: user.email, name: user.display_name },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        // Generate new refresh token (random string)
        const newRefreshToken = crypto.randomBytes(64).toString('hex');
        const newTokenHash = crypto
            .createHash('sha256')
            .update(newRefreshToken)
            .digest('hex');

        // Store new refresh token hash in DB
        await db.query(
            'INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at) VALUES ($1, $2, $3, $4)',
            [user.id, newTokenHash, stored.device_info, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)]
        );

        // Set new cookies on the response
        setAuthCookies(res, newAccessToken, newRefreshToken);

        // Set req.user so the controller works normally
        req.user = { id: user.id, email: user.email, name: user.display_name };

        return next();  // ✓ refreshed, proceed to controller

    } catch (err) {
        clearAuthCookies(res);
        return res.status(401).json({ error: 'Authentication failed' });
    }
}
```

### Cookie Helpers

```javascript
function setAuthCookies(res, accessToken, refreshToken) {
    res.cookie('access_token', accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: 15 * 60 * 1000              // 15 minutes
    });

    res.cookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',                           // ← same as access_token, needed for server-side refresh
        maxAge: 7 * 24 * 60 * 60 * 1000     // 7 days
    });
}

function clearAuthCookies(res) {
    res.cookie('access_token', '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: 0
    });

    res.cookie('refresh_token', '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: 0
    });
}
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

```javascript
const PUBLIC_ROUTES = [
    'POST /auth/register',
    'POST /auth/login',
    'GET  /auth/verify-email',
    'POST /auth/forgot-password',
    'POST /auth/reset-password',
    'GET  /auth/oauth/google',
    'GET  /auth/oauth/google/callback',
    'GET  /auth/oauth/microsoft',
    'GET  /auth/oauth/microsoft/callback',
];
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
POST   /auth/set-password                — set password for OAuth users [authenticated]
DELETE /auth/link/:provider              — unlink OAuth provider [authenticated]

GET    /users/me                         — get current user profile [authenticated]
PATCH  /users/me                         — update profile (name, avatar) [authenticated]
GET    /users/me/repos                   — list repos user is member of [authenticated]
GET    /users/me/oauth-links             — list linked OAuth providers [authenticated]
GET    /users/me/sessions                — list active sessions [authenticated]
DELETE /users/me/sessions/:id            — revoke a specific session [authenticated]
```

### Page Navigation Endpoints (browser navigates to these — NOT called by JS)

These are full page navigations triggered by `<a href="...">` links or `window.location`. The browser loads these URLs directly. The backend responds with 302 redirects, never JSON.

```
GET    /auth/verify-email?token=xxx      — verify email → sets cookies → 302 to /dashboard
GET    /auth/oauth/google                — start Google login → 302 to Google
GET    /auth/oauth/google/callback       — Google callback → sets cookies → 302 to /dashboard or /login?error=...
GET    /auth/oauth/microsoft             — start Microsoft login → 302 to Microsoft
GET    /auth/oauth/microsoft/callback    — Microsoft callback → sets cookies → 302 to /dashboard or /login?error=...
GET    /auth/link/google                 — start Google link → 302 to Google [authenticated]
GET    /auth/link/google/callback        — link callback → 302 to /settings?linked=google or /settings?error=...
GET    /auth/link/microsoft              — start Microsoft link → 302 to Microsoft [authenticated]
GET    /auth/link/microsoft/callback     — link callback → 302 to /settings?linked=microsoft or /settings?error=...
```

**No `/auth/refresh` endpoint.** Token refresh is handled transparently by the auth middleware on every protected route.

**No client-side OAuth logic.** The client triggers OAuth with a link (`<a href="/auth/oauth/google">`), and the backend handles everything: redirect to provider, callback processing, user creation, cookie setting, and final redirect to the app. The client only reads `?error` or `?linked` query params to show status messages.

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

```javascript
const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: (req) => req.ip,
    message: { error: 'Too many attempts, try again later' }
});

app.use('/auth/login', authLimiter);
app.use('/auth/register', authLimiter);
```

---

## 8. Cleanup Job

Revoked and expired refresh tokens accumulate in the DB over time. A scheduled job cleans them up.

### What Gets Cleaned Up

```sql
-- Tokens that are safe to delete:
-- 1. Revoked tokens older than 30 days (kept for 30 days for audit trail)
-- 2. Expired tokens older than 30 days (user never came back to refresh)
DELETE FROM refresh_tokens
WHERE created_at < NOW() - INTERVAL '30 days'
AND (revoked = TRUE OR expires_at < NOW());
```

### Why 30 Days (Not Immediately)

- **Audit trail**: If a user reports suspicious activity, you can check when/where tokens were revoked
- **Theft investigation**: The `revoked_at` timestamps show the exact sequence of events
- **Concurrent request grace period**: Freshly revoked tokens (< 10 sec) are still referenced by the middleware
- After 30 days, tokens have no forensic or operational value → safe to delete

### Implementation (node-cron)

```javascript
const cron = require('node-cron');

// Run daily at 3:00 AM
cron.schedule('0 3 * * *', async () => {
    try {
        const result = await db.query(`
            DELETE FROM refresh_tokens
            WHERE created_at < NOW() - INTERVAL '30 days'
            AND (revoked = TRUE OR expires_at < NOW())
        `);
        console.log(`[Cleanup] Deleted ${result.rowCount} expired/revoked refresh tokens`);
    } catch (err) {
        console.error('[Cleanup] Failed to clean refresh tokens:', err);
    }
});
```

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
- OAuth provider tokens: encrypted at rest in DB (AES-256-GCM)

### API Security
- All endpoints over HTTPS (required for Secure cookies)
- CORS configured for specific frontend origin only, with `credentials: true`
- Helmet.js for security headers (X-Frame-Options, CSP, HSTS, etc.)
- Input validation on all endpoints (zod schemas)
- SQL injection prevented by parameterized queries (never string concat)

### CORS Configuration (required for cookies)

```javascript
app.use(cors({
    origin: process.env.FRONTEND_URL,   // e.g., 'https://bitsync.app'
    credentials: true                    // required for cross-origin cookies
}));
```

### Session Management
- On password change → revoke ALL refresh tokens → clear cookies (force re-login everywhere)
- On account deletion → revoke all tokens, remove all memberships, clear cookies
- On OAuth unlink → delete oauth_link row
- Sessions page: user can see active sessions (device_info) and revoke individually

### Email Security
- Verification emails: signed JWT, 24-hour expiry
- Password reset emails: signed JWT, 1-hour expiry
- Rate limit email sends (1 per minute per email)
- Never reveal whether an email exists in forgot-password responses
