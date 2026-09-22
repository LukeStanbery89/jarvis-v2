# server/src/auth — accounts, devices, and the app database

This README explains how the auth module is organized. It shares one file per
concern so the REST and WebSocket layers consume narrow seams, never raw SQL.

## Files

| File        | Responsibility                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`  | `AppUser`/`AppDevice`/`AppSession` row shapes, `Role`, `ResolvedIdentity`, and `AuthContext` (what `req.jarv` / the WS ctx carry)                  |
| `crypto.ts` | Password hashing (`crypto.scrypt`, self-describing `scrypt$N$r$p$salt$key` strings) + device-token generation/hashing                              |
| `store.ts`  | `AppDatabase` seam + `SqliteAppDatabase` (better-sqlite3) over `JARVIS_DB_PATH` (`~/.jarvis/jarvis.sqlite`); schema migrations; the session ledger |
| `errors.ts` | `AuthError` with a stable `code` (routes map it to status codes) and a user-safe `message`                                                         |
| `README.md` | this file                                                                                                                                          |

The REST layer lives outside this module in `src/http/` (`middleware.ts` =
`requireAuth`/`requireOwner` filling `req.jarv`; `authRoutes.ts` = the `/api`
router) — it consumes these seams and never touches SQL.

## Credential model

- **Passwords** → scrypt; parameters are embedded in the stored string, so
  cost can be raised over time without a schema change. Verification is
  constant-time.
- **Device tokens** → 32 random bytes (base64url). Only their SHA-256 hash and
  an 8-char display `prefix` are persisted (`crypto.ts`). A leaked DB never
  leaks a usable token; a support listing never shows one.
- **Verifier seam.** Password verification happens in exactly one place —
  `src/http/authRoutes.ts`: `getPasswordHash(username)` then
  `verifyPassword(password, hash)`. A username with no row verifies against a
  cached same-cost dummy hash so account existence can't be inferred from
  response time. Device tokens are the credential for everything else:
  the presented token is run through `hashDeviceToken` and looked up by exact
  `secret_hash` in `store.resolveTokenHash`. Nothing outside the REST/WS layers
  compares credentials, and the store only ever seats hash-versus-hash
  equality. Biometric auth (issue #25) slots in at the login seam — replace
  the password step with a biometric challenge and still provision a device
  token afterwards.

## App database

`JARVIS_DB_PATH` (default `~/.jarvis/jarvis.sqlite`), migrated via
`PRAGMA user_version`:

- `users` — `username` (unique, case-insensitive), `password_hash`, `role`
  (`owner`/`user`).
- `devices` — per-credential rows keyed to a user; `secret_hash` + `prefix`.
- `sessions` — the WS-turn ledger: one row per `thread_id` (unique), owned by
  a user/device or `NULL` (guest), with `kind` (`text`/`voice`) for the
  lifecycle matrix. `claimSession` claims atomically
  (`INSERT … ON CONFLICT DO NOTHING`, returning `created`); `touchSession`
  maintains `last_active_at`; `deleteSession` and `listOwnedSessions` back the
  REST management API and guest cleanup. The WS layer decides _when_ rows are
  deleted (guest sockets on close), not the store.
- `prefs` — per-user integration prefs (JSON values); LLM settings stay in
  the environment.

## Rules for callers

- Owned data (sessions, prefs) is always resolved _relative to the identity_
  in `AuthContext`; never trust a client-supplied owner id.
- Guests (`user: null`, `device: null`) may reach identity-independent
  actions only. The lifecycle matrix and ownership checks live at the
  WS/REST layers, not in the store.
- The store never hashes or compares secrets — that is `crypto.ts`'s job;
  the REST/WS layers that received a presented token call `hashDeviceToken`
  before any `resolveTokenHash` lookup.
