# @lukestanbery/jarvis-auth — accounts, devices, sessions, and the app database

The auth core for J.A.R.V.I.S.: the account/device/credential seams and the
better-sqlite3 app database every authenticated endpoint and WebSocket turn
runs against. Extracted from the original `packages/server/src/auth/` so the
server's REST management API, its `/ws` chat handshake, and — once the cookie
web portal (#24) lands — its browser sessions all share one implementation.

This README is the module guide for how the package is organized: one file per
concern so consumers depend on narrow seams, never raw SQL.

## Files

| File            | Responsibility                                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`      | `AppUser`/`AppDevice`/`AppSession` row shapes, `Role`, `ResolvedIdentity`, and `AuthContext` — the discriminated `guest \| authed \| session` union that `req.jarv` / the WS ctx carry (narrow by `kind` to reach non-null `user`/`device`, or the session's `user`/`csrfToken`)               |
| `crypto.ts`     | The raw primitives: password hashing (`crypto.scrypt`, self-describing `scrypt$N$r$p$salt$key` strings) + device-token generation/hashing                                                                                                                                                      |
| `credential.ts` | The `CredentialVerifier` seam (`hash`/`verify`) — what the REST layer codes against; wraps `crypto.ts` and owns the timing-equalized dummy-hash for unknown usernames                                                                                                                          |
| `ownership.ts`  | `ownsRow` / `canManage` — the single row-ownership policy shared by the WS session pipeline and the REST management routes                                                                                                                                                                     |
| `store.ts`      | The `AppDatabase` seam (`AppDatabase = UserLedger & DeviceLedger & WebSessionLedger & PrefLedger & SessionLedger & { close() }`) + `SqliteAppDatabase` (better-sqlite3) over `JARVIS_DB_PATH` (`~/.jarvis/jarvis.sqlite`); schema migrations; the session-ledger + prefs + web-session ledgers |
| `cookie.ts`     | `CookieSessionProvider` — the browser-session equivalent of the device-token flow: issues 32-byte cookie secrets (hash-at-rest), per-session CSRF nonces, expiry, and revoke over the `WebSessionLedger`                                                                                       |
| `errors.ts`     | `AuthError` with a stable `code` (routes map it to status codes) and a user-safe `message`                                                                                                                                                                                                     |
| `fs.ts`         | Best-effort private filesystem posture: `~/.jarvis` narrowed to `0700` and each SQLite database (app DB + LangGraph checkpoints) pre-created at `0600`                                                                                                                                         |
| `README.md`     | this file                                                                                                                                                                                                                                                                                      |

The REST layer lives outside this package in the server's `src/http/` (`middleware.ts` = `requireAuth`
[bearer-then-cookie fallback]/`requireOwner`/`requireCsrf` filling `req.jarv`; `cookies.ts` = the web-session
cookie; `authRoutes.ts` = the `/api` router) — it consumes these seams and never touches SQL. The `/ws` handshake
(`src/ws.ts`) resolves device tokens through the same store. The cookie-session provider (`cookie.ts`) is what the
browser portal (#24) authenticates through, so the cookie provider and the CLI/device-token path share one ledger.

## Ledger roles

`AppDatabase` is an intersection of five narrower roles, so consumers depend on
only the surface they call:

- `UserLedger` — account rows + stored password hashes (`getPasswordHash` is
  for the credential-verifier seam only); role promotion/demotion
  (`setUserRole`, `OWNER_EXISTS` on a second owner) and disable/re-enable
  (`setUserDisabled`).
- `DeviceLedger` — device credentials and token resolution: presented tokens
  run through `hashDeviceToken` (crypto) before `DeviceLedger.resolveTokenHash`.
  `renameDevice` renames a device (a name already used by the same user throws
  `BAD_REQUEST`). Token resolution excludes **disabled** accounts, so disabling
  a user revokes every kept credential instantly.
- `WebSessionLedger` — browser cookie sessions (`CookieSessionProvider`):
  hash-keyed rows over the `web_sessions` table; issue/get/delete + delete-all.
- `PrefLedger` — per-user integration prefs over the `prefs` table:
  `getPrefs`/`setPrefs` (upsert) / `deletePrefKeys`, JSON values round-tripped
  through `value_json`.
- `SessionLedger` — the WS chat sessions (`claimSession` / get-by-thread /
  touch / delete / `listOwnedSessions` / `listAllSessions` [owner-wide]).
  The server's `SessionManager`
  (`packages/server/src/sessionManager.ts`) is typed against exactly this role.

The server's `createApp`/`attachChatServer` are the composition roots; the REST
router and middleware span all five ledgers and therefore take the full
`AppDatabase`, while `createSessionManager` narrows to `SessionLedger`.

## Credential model

- **Passwords** → scrypt; parameters are embedded in the stored string, so
  cost can be raised over time without a schema change. Verification is
  constant-time.
- **Device tokens** → 32 random bytes (base64url). Only their SHA-256 hash and
  an 8-char display `prefix` are persisted (`crypto.ts`). A leaked DB never
  leaks a usable token; a support listing never shows one.
- **Cookie sessions** → the same shape for browsers (`cookie.ts`): a 32-byte
  base64url token that rides an HttpOnly cookie, stored only as a SHA-256 hash,
  plus a per-session CSRF nonce the portal echoes in an `x-csrf-token` header.
  Absolute expiry (`DEFAULT_SESSION_TTL_MS`, 30 days); revoke deletes the row.
- **Verifier seam.** Password hashing + verification happens in exactly one
  place — `credential.ts`, the `CredentialVerifier` used by the server's
  `authRoutes.ts`: `getPasswordHash(username)` then
  `verify(username, storedHash)`. A username with no row (a `null` hash)
  verifies against a cached same-cost dummy hash so account existence can't be
  inferred from response time. Device tokens are the credential for everything
  else: the presented token is run through `hashDeviceToken` and looked up by
  exact `secret_hash` in `store.resolveTokenHash`. Nothing outside this
  package's credential seam ever hashes or compares secrets, and the store only
  ever seats hash-versus-hash equality. Biometric auth (issue #25) slots in at
  the login seam — replace the password step with a biometric challenge and
  still provision a device token afterwards.

## App database

`JARVIS_DB_PATH` (default `~/.jarvis/jarvis.sqlite`), migrated via
`PRAGMA user_version`:

- `users` — `username` (unique, case-insensitive), `password_hash`, `role`
  (`owner`/`user`), `disabled` (revoke-by-disable: a disabled account's stored
  device tokens stop resolving).
- `devices` — per-credential rows keyed to a user; `secret_hash` + `prefix`.
- `web_sessions` — browser cookie sessions: hash-keyed rows (`secret_hash`
  UNIQUE) with a per-session `csrf_token` and `expires_at`; cascade-deleted
  with their user. Managed by the `CookieSessionProvider` + `WebSessionLedger`.
- `sessions` — the WS-turn ledger: one row per `thread_id` (unique), owned by
  a user/device or `NULL` (guest), with `kind` (`text`/`voice`) for the
  lifecycle matrix. `claimSession` claims atomically
  (`INSERT … ON CONFLICT DO NOTHING`, returning `created`); `touchSession`
  maintains `last_active_at`; `deleteSession` and `listOwnedSessions` back the
  REST management API and guest cleanup. The WS layer decides _when_ rows are
  deleted (guest sockets on close), not the store.
- `prefs` — per-user integration prefs (JSON values in `value_json`); LLM
  settings stay in the environment. Reached through the `PrefLedger` accessors
  — the reserved home for the per-user integration state the web portal (#24)
  manages, from a consumer (v4 schema, planning-complete) onward.

`openAppDatabase(path)` creates + pre-narrows the file's directory (via
`fs.ts`) before SQLite touches it, so the world-readable window SQLite's
default `0644` creation would open is closed up front. Tests construct
`SqliteAppDatabase` over `":memory:"` directly.

## Rules for callers

- Owned data (sessions, prefs) is always resolved _relative to the identity_
  in `AuthContext`; never trust a client-supplied
  owner id.
- Guests (`kind: "guest"` — no user/device) may reach identity-independent
  actions only. Row ownership is decided by the shared policy in
  `ownership.ts` (`ownsRow` for the WS chat path, `canManage` for REST) — the
  lifecycle matrix lives in the server's WS/REST + `sessionManager.ts` layers,
  not in the store.
- The store never hashes or compares secrets — that is `crypto.ts`'s job, and
  the REST layer reaches it only through the `CredentialVerifier` seam. The
  REST/WS layers that received a presented token call `hashDeviceToken`
  before any `resolveTokenHash` lookup.
