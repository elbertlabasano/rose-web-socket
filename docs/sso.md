# Rose SMS administration and SSO

The Node.js service serves a public homepage, Rose Account sign-in, and an
administrator-only dashboard at the same origin as the existing SMS API.
The dashboard shows service health, connected devices and all-time counts by
message status. It has no message history, recipients, message bodies, or SMS
export. The existing authenticated message-by-ID API is preserved.

## Deploy

Use Node.js 22 LTS or newer and the existing MySQL/MariaDB database. Back up the
database before migrating. From the repository directory:

Existing database users also need `DELETE` on the SMS database for session
cleanup and sign-out; the original setup granted only SELECT/INSERT/UPDATE.
Grant that permission using your database administrator before enabling SSO.
The optional SQL tests additionally need `CREATE TEMPORARY TABLES`.

```powershell
npm ci
npm run migrate
npm start
```

Merge these settings into the server's existing `.env`, preserving `API_TOKEN`
and all database credentials:

```dotenv
SSO_ENABLED=true
APP_URL=https://sms.jathnier.com
KEYCLOAK_BASE_URL=https://sso.rosebakeshop.net
KEYCLOAK_REALM=jathnier
KEYCLOAK_CLIENT_ID=sms
KEYCLOAK_CLIENT_SECRET=your-sms-client-secret
SSO_BOOTSTRAP_ADMIN_IDCODE=20260211
```

The supplied client secret can be kept in the ignored `.env.sso` file alongside
the existing `.env`. To use that file without merging it, run:

```powershell
node --env-file=.env --env-file=.env.sso server.js
```

The second file overrides matching values from the first; operating system
environment variables take precedence. Update a scheduled task's arguments
accordingly if using two files. Do not commit either file or put the client
secret in frontend JavaScript. `.env.example` contains placeholders only.

The migration adds `sms_admins`, `sms_sessions`, `sms_api_tokens`, and
`sms_admin_settings`. It inserts employee `20260211` once, inside a transaction.
Repeating the migration does not reactivate a revoked bootstrap administrator.
Run the migration before enabling the dashboard. Existing SMS rows and device
tokens are unchanged. Restart the Node process after deploying changes.

## Keycloak client settings

In realm **jathnier**, configure client **sms**:

| Setting | Value |
| --- | --- |
| Client type | OpenID Connect |
| Client authentication | On |
| Standard flow | On |
| Implicit flow / direct access grants / service accounts | Off |
| Root URL | `https://sms.jathnier.com` |
| Home URL | `https://sms.jathnier.com/` |
| Valid redirect URI | `https://sms.jathnier.com/auth/keycloak/callback` |
| Local development redirect URI | `http://127.0.0.1:3000/auth/keycloak/callback` |
| Web origins | Empty; authentication happens on the backend |
| Post logout redirect URI | Not needed; sign-out is local only |
| PKCE challenge method | S256 |

The production callback **does not contain `/t/`**. Replace the `/t/auth/...`
entry shown in the initial configuration screenshot. Use exact redirect URIs.
For local development set `APP_URL=http://127.0.0.1:3000`; do not alternate
between localhost and 127.0.0.1 during a login flow.

Configure an `idcode` User Attribute mapper in the `sms` client's scopes:
single string, included in UserInfo (and optionally the ID token). Only
administrators should edit employee codes in Keycloak. Preserve leading zeros,
keep codes unique, and ensure the initial administrator has exactly `20260211`.
Missing, array-valued, padded or malformed codes cannot sign in.

## Authentication and administrator access

The implementation uses `openid-client` Authorization Code flow with S256 PKCE,
state and nonce. It verifies the ID token signature, issuer, audience, lifetime
and nonce, and requires UserInfo's subject to match the ID token. Discovery and
provider calls use verified HTTPS. Provider credentials and tokens never reach
the application's browser code or logs.

An approved employee code is linked to the Keycloak issuer and subject at first
login. A replacement SSO identity cannot silently inherit that link. Such
changes require a reviewed database correction; re-adding a revoked employee
preserves their identity link. This application does not create Keycloak users.

Sessions last eight hours, use opaque random cookies, and are stored hashed in
the database. Production cookies are Secure, HttpOnly, SameSite=Lax and
host-only. Login attempts expire after ten minutes and callbacks are consumed
once. Sessions survive Node restarts. Each request checks whether the associated
administrator is still authorized. Administrator revocation invalidates local
access immediately on the next request. Administrators cannot revoke themselves.

Every authorized administrator can add/revoke other administrators and manage
all application API tokens. POST actions require a session-bound CSRF token and
an Origin matching `APP_URL`. The application uses the configured origin rather
than trusting arbitrary forwarded host headers. Its HTTPS proxy must forward
cookies and query parameters and must not cache private pages.

Sign-out deletes only this app's session. It does not log the user out of Rose
SSO or other applications. Disabling an account in Keycloak does not instantly
end an existing local eight-hour session; revoke the administrator here for
immediate local denial. Backchannel logout is not implemented.

## API tokens

Administrators can create a named token with a seven-, thirty-, ninety- or
365-day expiration, or no expiration. The full secret appears only in the
creation response. Store it in the calling application's server environment.
Only its SHA-256 hash and a short identification prefix are stored. The list
shows creator, expiration, revocation and last successful authentication time.
Revocation takes effect on subsequent API requests; previously accepted jobs
remain in the queue.

Managed tokens authorize `POST /sms` and `GET /sms/:id`. They cannot register or
list devices, sign in to the dashboard, or administer tokens/users. Message
lookups retain the current API's service-wide semantics: managed tokens are
not isolated to only the messages submitted using that token. Avoid giving
them to untrusted clients. The UI never uses this message lookup endpoint.

The original fixed `API_TOKEN` remains enabled with its original API privileges.
It is deliberately not displayed or revocable in the dashboard; change it in
the server environment when ready to retire it. LILYGO WebSocket device tokens
are separate and are not rotated by the new token manager. The existing limit
of 20 dispatch attempts per minute per device still applies.

## Verification

Run `npm test`. Tests cover the real OIDC client with a mock signed provider,
invalid state/nonce/issuer/audience/expiry/signature, UserInfo mismatch, missing
codes, admin allowlisting and revocation, CSRF, token creation/revocation,
legacy API compatibility and absence of SMS content from the dashboard.

SQL tests are optional with configured database credentials:

```powershell
node --env-file=.env --test test/admin-store.test.js test/store.test.js
```

They use connection-scoped temporary tables, not the real queue or admin tables.
A production migration and a real browser SSO login must still be checked on
deployment: an automated mocked login cannot prove the Keycloak client secret,
employee mapper, registered callback or reverse proxy configuration is correct.

Reference: [openid-client documentation](https://github.com/panva/openid-client/tree/main/docs).
