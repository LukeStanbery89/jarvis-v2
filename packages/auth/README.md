# @lukestanbery/jarvis-auth — accounts, devices, sessions, and the app database

The auth core for J.A.R.V.I.S.: the account/device/credential seams and the
better-sqlite3 app database every authenticated endpoint and WebSocket turn
runs against. Extracted from the original `packages/server/src/auth/` so the
server's REST management API, its `/ws` chat handshake, and — once the cookie
web portal (#24) lands — its browser sessions all share one implementation.

This README is the module guide for how the package is organized: one file per
concern so consumers depend on narrow seams, never raw SQL.

## Files

| File            | Responsibility                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`      | `AppUser`/`AppDevice`/`AppSession` row shapes, `Role`, `ResolvedIdentity`, and `AuthContext` — the discriminated `guest \| authed \| session` union that `req.jarv` / the WS ctx carry (narrow by `kind` to reach non-null `user`/`device`, or the session's `user`/`csrfToken`)                                                                     |
| `crypto.ts`     | The raw primitives: password hashing (`crypto.scrypt`, self-describing `scrypt$N$r$p$salt$key` strings) + device-token generation/hashing                                                                                                                                                                                                            |
| `credential.ts` | The `CredentialVerifier` seam (`hash`/`verify`) — what the REST layer codes against; wraps `crypto.ts` and owns the timing-equalized dummy-hash for unknown usernames                                                                                                                                                                                |
| `ownership.ts`  | `ownsRow` / `canManage` — the single row-ownership policy shared by the WS session pipeline and the REST management routes                                                                                                                                                                                                                           |
| `store.ts`      | The `AppDatabase` seam (`AppDatabase = UserLedger & DeviceLedger & WebSessionLedger & PrefLedger & SessionLedger & NotificationLedger & JobLedger & { close() }`) + `SqliteAppDatabase` (better-sqlite3) over `JARVIS_DB_PATH` (`~/.jarvis/jarvis.sqlite`); schema migrations; the session-ledger + prefs + web-session + notification + job ledgers |
| `testing.ts`    | Test-support only, reachable via the `@lukestanbery/jarvis-auth/testing` subpath (a separate entry point, kept off the production surface): `createInMemoryAppDatabase()` — a migrated `AppDatabase` over `:memory:` with no filesystem side effects                                                                                                 |
| `cookie.ts`     | `CookieSessionProvider` — the browser-session equivalent of the device-token flow: issues 32-byte cookie secrets (hash-at-rest), per-session CSRF nonces, expiry, and revoke over the `WebSessionLedger`                                                                                                                                             |
| `errors.ts`     | `AuthError` with a stable `code` (routes map it to status codes) and a user-safe `message`                                                                                                                                                                                                                                                           |
| `fs.ts`         | Best-effort private filesystem posture: `~/.jarvis` narrowed to `0700` and each SQLite database (app DB + LangGraph checkpoints) pre-created at `0600`                                                                                                                                                                                               |
| `README.md`     | this file                                                                                                                                                                                                                                                                                                                                            |

The REST layer lives outside this package in the server's `src/http/` (`middleware.ts` = `requireAuth`
[bearer-then-cookie fallback]/`requireOwner`/`requireCsrf` filling `req.jarv`; `cookies.ts` = the web-session
cookie; `authRoutes.ts` = the `/api` router) — it consumes these seams and never touches SQL. The `/ws` handshake
(`src/ws.ts`) resolves device tokens through the same store. The cookie-session provider (`cookie.ts`) is what the
browser portal (#24) authenticates through, so the cookie provider and the CLI/device-token path share one ledger.

## Ledger roles

`AppDatabase` is an intersection of narrower roles, so consumers depend on
only the surface they call:

- `UserLedger` — account rows + stored password hashes (`getPasswordHash` is
  for the credential-verifier seam only); role promotion/demotion
  (`setUserRole`: promoting adds an **owner** alongside any existing one,
  demoting an owner throws `LAST_OWNER` unless another **enabled** owner
  remains) and disable/re-enable (`setUserDisabled`).
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
- `NotificationLedger` — JARVIS's outbound messages to a user (#139) over the
  `notifications` table: `createNotification` / `getNotification` /
  `listNotifications` (newest first, dismissed hidden by default) /
  `countUnreadNotifications` / `setNotificationState` / `pruneNotifications`.
  Every method scopes by `userId`, so a foreign id is indistinguishable from a
  missing one — the reason the REST layer needs no ownership check. The store
  owns _transitions_ (terminal states are terminal, `delivered_at` and
  `settled_at` are stamped by the states that imply them) while the server's
  notification service owns the _policy_ (when to push, quiet hours, caps,
  retention).
- `JobLedger` — the scheduler's queue and history (#90) over the `jobs` and
  `job_runs` tables: `createJob` / `getJob` / `listJobs` / `cancelJob` /
  `moveJob` / `editJob` /
  `listJobRuns` / `pruneJobs` / `pruneJobRuns`, plus the **scheduler-scoped**
  half (`listDueJobs` / `claimJob` / `rescheduleJob` / `rearmJob` /
  `startJobRun` / `finishJobRun` / `settleJob` / `settleJobRun`)
  that no request handler may reach. `settleJobRun` is the one that records a
  firing's ending — the run's row and the job's next state (owed again, or
  settled) — as a single transaction, because the two are one fact; the
  announcement stays outside it. `cancelJob` accepts a **repeating** job while
  it runs (the firing in flight still reports; the series must not continue),
  which is safe because the re-arm only fires on a row that is still `running`
  — and a live repeating row is exempt from `pruneJobs`, whose `created_at`
  never moves and which would otherwise be the first row age took. `rearmJob` is
  the same move without the run row: a claimed job whose slot passed while nobody
  was looking, which is why it needs the claim-scoped `running` guard rather than
  `rescheduleJob`'s `pending` one. `editJob` carries the rule too, with the wire's own three states:
  a rule to write, `null` to stop repeating, `undefined` to leave it — JSON cannot
  spell `undefined`, so a request's absent field and its explicit `null` already
  mean exactly those, and no sentinel is needed. `countModelRuns` / `recordModelRun` are the
  scheduler's **daily model-run budget** (below), which is a count this package
  owns because it has to outlive a restart. This is the one ledger with two surfaces
  on purpose: a job belongs to one user, but the scheduler is a _process_
  acting for every user at once, so it selects due work across accounts and
  settles it by the id it claimed. `claimJob` is the load-bearing statement —
  `state = 'pending'` sits in its WHERE clause, which is what makes a second
  tick, or a process that restarted mid-run, unable to fire a job twice. The
  user-scoped state changes (`cancelJob`, `moveJob`, `editJob`) put the same
  `user_id` + `state = 'pending'` predicates in their own WHERE clauses, so
  ownership and "still owed" are one statement rather than a read-then-write
  window. The store owns rows and transitions; the server's scheduler owns the
  _policy_ (what may be scheduled, what a run means, deferral, retention).

The server's `createApp`/`attachChatServer` are the composition roots; the REST
router and middleware span every ledger and therefore take the full
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
  Device names are unique per user, enforced by exactly one UNIQUE
  `(user_id, name)` index: fresh databases carry the inline table constraint,
  legacy stores carry the named `idx_devices_user_name` from the v2
  migration — the v6 migration drops the named index wherever the inline
  constraint already exists, so every database converges on one enforcement.
- `web_sessions` — browser cookie sessions: hash-keyed rows (`secret_hash`
  UNIQUE) with a per-session `csrf_token` and `expires_at`; cascade-deleted
  with their user. Managed by the `CookieSessionProvider` +
  `WebSessionLedger`; the provider's `issue` sweeps expired rows
  (`deleteExpiredWebSessions`), so the table self-cleans without a timer.
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
- `notifications` — one row per notification (#139, v7; `class` added in v9,
  `job_id` in v11, the state CHECK widened in v12 — both #90): producer `kind` +
  `class` (the delivery policy — a `timer` pierces quiet hours, everything else
  waits) + `priority` (display
  emphasis only), the
  `title`/`body` text, a `state` lifecycle (`pending` →
  `delivered` → then the terminal set: `read`/`answered`/`dismissed`/**`snoozed`**,
  with `pending` → `read` legal
  for a notification the user found in the list rather than had pushed), an
  optional `requires_answer`, `dedupe_key`, and `answer`, plus the timestamps.
  Indexed on `(user_id, created_at DESC)` for the list; cascade-deleted with
  the user. `pending` is not an error state — it is the normal outcome for a
  user who was offline — so the table is also the delivery queue's record of
  what still wants attention. `job_id` (nullable, `ON DELETE SET NULL`) is how
  a scheduler announcement names the job it came from: it is what lets a
  reminder row offer _snooze_ rather than only _dismiss_ (and what settles that
  row when the snooze lands — `listNotificationsForJob` is how the server finds
  it without guessing an id), and it is the one
  link a notification needs, because everything else it says is already
  rendered into its text. Jobs are pruned as history while a notification the
  user was already shown stays true, so the prune clears the link and keeps the
  row.
- `jobs` — one row per scheduled job (#90, v8; rebuilt in v10 for `class` and
  the `message` payload): `label`, `class` (the delivery class its announcement
  carries — `notification`/`reminder`/`timer`), `kind` (`prompt`/`tool`/
  `message`) with the prompt, the tool call, _or_ the message text (a CHECK
  refuses a row whose payload does not match its kind), `run_at`, a `state`
  lifecycle (`pending` → `running` → `done`/`failed`/`cancelled`/`missed`),
  `attempts`, `last_error`, `gate` (the deterministic check a firing must pass,
  as JSON, v15) and `repeat` (the recurrence rule as JSON, v13 —
  read defensively: a value that will not parse comes back as its raw text, so
  the scheduler can report a rule it cannot read rather than pretending the job
  is a one-shot). Indexed on `(user_id, created_at DESC)` for the
  owner's list and on `(run_at) WHERE state = 'pending'` — a partial index,
  because the scheduler's claim feed only ever scans pending work. The v10
  rebuild is the documented SQLite dance for widening a CHECK (which cannot be
  altered in place), run with foreign keys off for the duration: `job_runs`
  references `jobs`, and dropping the old table with enforcement on would
  cascade a user's run history away. `missed` is deliberately
  not `failed`: a job whose moment passed while the server was down was never
  attempted.
- `job_model_runs` — the daily model-run budget (#90 phase 8c): `user_id`, a
  local `day` (`YYYY-MM-DD`) and a count, one row per account per day, never
  pruned (a year is 365 rows). A _budget_ rather than a throttle, which is why it
  is a row here instead of an in-memory limiter in the server: a restart must not
  hand the day's allowance back, exactly when a runaway job would spend it again.
  The server owns the ceiling and what a day means; this table owns the count.
- `job_runs` — one row per attempt at a job: `started_at`/`finished_at`, the
  run's `state` (`running`/`ok`/`failed`/`skipped`), the `output` it produced (the
  reply, or a tool's result text) and the `error` it ended with. `skipped` is a
  firing that _declined_ — a gate's check found nothing to do — which is why it is
  a run rather than silence: one run row per firing is the trace this table owes.
  `gate_output`/`gate_key` are that check's memory (#90 phase 8f): what it read,
  and which check read it, so a changed gate is a different question rather than a
  changed answer. Cascade-deleted with
  its job even when the _job_ is pruned. The newest runs of each job are kept
  (`pruneJobRuns`, 50 by default — comfortably above the detail endpoint's
  page): a job that fires every few minutes writes one per firing, so the job
  count no longer bounds this table. This is the job's observable history;
  the model's own context lives in the LangGraph checkpoint under a `job:<id>`
  thread that never enters the `sessions` ledger, which is what keeps a job's
  runs out of the chat-thread list.

`openAppDatabase(path)` creates + pre-narrows the file's directory (via
`fs.ts`) before SQLite touches it, so the world-readable window SQLite's
default `0644` creation would open is closed up front.

### Testing against the store

Tests should not construct `SqliteAppDatabase` over `":memory:"` themselves.
Import the factory from the **`/testing` subpath**, which is a separate entry
point so it stays off the production surface:

```ts
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";

const store = createInMemoryAppDatabase();
// ... exercise store ...
store.close();
```

It returns a fully-migrated `AppDatabase` (the constructor runs the schema
migrations) backed by `:memory:`, with no filesystem side effects. Each call
yields an independent database, so call it per test rather than reusing one
store. It deliberately skips `openAppDatabase`'s `0700`/`0600` posture — that is
meaningless for an in-memory database, and the on-disk posture is asserted
against real temp files in `test/store.test.ts`, which is also the one suite that
still imports the driver directly (it needs the raw handle for raw-SQL fixtures
and pre-v4/v3 migration upgrades).

Do not use the factory in production code: an in-memory database is discarded
when the process exits.

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
