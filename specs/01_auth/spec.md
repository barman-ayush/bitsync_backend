# 01 — Authentication Spec

This specification details the design for email + password authentication and session management in BitSync.

## 1. Data Model

BitSync authentication uses two main database entities:

### 1.1 Users
Stores central identity records:
- `id` (UUID, Primary Key)
- `email` (string, unique, normalized)
- `username` (string)
- `usernameNormalized` (string, unique)
- `displayName` (string)
- `avatarUrl` (string, nullable)
- `passwordHash` (string, nullable if OAuth is used, otherwise stores the bcrypt hash)
- `emailVerified` (boolean, defaults to false)
- `createdAt` & `updatedAt` (timestamps with timezone)

### 1.2 Refresh Tokens
Stores active session tokens (stored as SHA-256 hashes for security):
- `id` (UUID, Primary Key)
- `userId` (UUID, Foreign Key referencing Users)
- `tokenHash` (string, unique SHA-256 hash of the token)
- `deviceInfo` (string, nullable, records User-Agent details)
- `expiresAt` (timestamp with timezone)
- `revoked` (boolean)
- `revokedAt` (timestamp with timezone, nullable)
- `createdAt` (timestamp with timezone)

---

## 2. Cookie Strategy

Authentication is handled via **HTTP-only, Secure cookies** managed automatically by the browser:

- **`access_token`**: A short-lived (15 minutes) signed JSON Web Token (JWT) identifying the user.
- **`refresh_token`**: A long-lived (7 days) random opaque string used to retrieve new access tokens.

Both cookies are scoped to the root path (`/`) to allow the authentication middleware to intercept any incoming API request and handle refreshes server-side. JavaScript running on the client cannot read, modify, or delete either cookie.

---

## 3. Token Types

- **Access Token (JWT)**: Signed with the server secret. It contains user details (`sub`, `email`, `name`). It is validated via cryptographic signature checks, requiring no database lookups for standard API actions.
- **Refresh Token**: A cryptographically random opaque hex string. Validation requires computing its SHA-256 hash and looking it up in the database. Unlike the JWT, the refresh token can be revoked at any time.

---

## 4. Authentication Flows

- **Registration**: Creates a user in an unverified state and sends a verification email.
- **Email Verification**: Consumes a temporary JWT token from a link, marks the email as verified, generates access and refresh tokens, sets the cookies on the response, and redirects the user to the application.
- **Login**: Verifies credentials, generates tokens, and sets both cookies on the response.
- **Logout**: Hashes the refresh token from the cookie, marks it as revoked in the database, and clears both cookies in the client browser.
- **Page Refresh / Navigation**: The browser automatically attaches both cookies. If the access token has expired, the middleware transparently rotates the refresh token and mints a new access/refresh token pair.

---

## 5. Auth Middleware (Server-Side Refresh)

The client application never manually manages tokens or triggers refreshes. The auth middleware handles session validation and token rotation dynamically:

1. **Verify Access Token**:
   - If present and valid, sets user details on the request and proceeds.
   - If expired or missing, triggers the token rotation logic.
   - If malformed or tampered, clears cookies and rejects the request with a `401` status code.

2. **Rotate Refresh Token**:
   - Reads the refresh token from the cookie, hashes it, and queries the database.
   - If the token is valid, it is revoked, and a new refresh token and access token are issued and set in the response cookies.
   - **Concurrent Request Grace Period**: If the token is found to be revoked within a small grace window (10 seconds), the request is treated as a concurrent page load. The client is told to retry, letting it use the newly rotated cookies issued by the parallel request.
   - **Theft Detection**: If a revoked token is reused outside the grace period, all active sessions for that user are immediately revoked, cookies are cleared, and access is denied.

---

## 6. Security Considerations

- **Password Storage**: Passwords are hashed using `bcrypt` with a work factor of 12. Password hashes are never returned in API responses or written to logs.
- **Cookie Flags**: All auth cookies are set with `HttpOnly` (preventing XSS access), `Secure` (forcing transmission over HTTPS), and `SameSite=Strict` (blocking CSRF attacks).
- **Session Revocation**: A password change or account compromise immediately revokes all refresh tokens in the database, forcing a complete logout across all devices.
