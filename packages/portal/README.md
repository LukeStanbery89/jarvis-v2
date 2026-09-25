# @lukestanbery/jarvis-portal

Web admin portal for J.A.R.V.I.S. — a React single-page app (issue #24) that
the server serves at `/` and that manages the server entirely through the REST
API from `@lukestanbery/jarvis-server`.

It is the owner-facing management surface: accounts, devices, sessions, and
prefs. It authenticates with the browser **cookie session** (`jarvis_session`)
— not device tokens — and echoes the per-session CSRF nonce on every mutation,
which is why the portal only ships alongside the TLS/CSRF-capable server (Phase
C).

## What it does

- **Login / sign-out** — `POST`/`DELETE /api/session`; the CSRF nonce is kept in
  memory only and recovered on reload via `GET /api/session`.
- **Setup** — one-time owner provisioning behind `JARVIS_BOOTSTRAP_TOKEN`
  (`#/setup`, reached from the login screen).
- **Users** (owner) — create accounts, promote/demote owner, disable/re-enable.
- **Devices** — owners manage any account's credentials (provision, rename,
  revoke); regular users manage their own. Freshly provisioned tokens are shown
  once — the server never stores them after issuance.
- **Sessions** — list/delete the chat-thread ledger; the owner sees all sessions
  with their owning user.
- **Prefs** — key/value JSON editor per user (owners can target any account);
  "Clear all" empties via the DELETE routes.

Non-owner role gating matches the REST policy (`requireOwner`); the UI simply
hides the Users view and user-scoped selects.

## Stack

- React 19 + Vite 8 + TypeScript (strict). No router library — a tiny
  hash-based router (`src/routes.ts`); no UI kit — plain components + CSS.
- Only runtime dependency is `react`/`react-dom`; everything else is dev/build.
- The only headless tests target the API client (`src/api.test.ts`, Vitest node
  environment, no jsdom).

## Scripts

Run from `packages/portal`:

| Command             | Description                                                           |
| ------------------- | --------------------------------------------------------------------- |
| `npm run dev`       | Vite dev server (HMR) with `/api` proxied to `http://localhost:54321` |
| `npm run build`     | Production bundle → `dist/` (served by the server at `/`)             |
| `npm run preview`   | Preview the production build locally                                  |
| `npm run typecheck` | Type-check `src/` + configs (`tsc --noEmit`)                          |
| `npm test`          | Run the API-client unit tests                                         |

## Serving

Point the server at the built bundle and start it:

```sh
npm run build           # builds every workspace incl. this portal
JARVIS_BOOTSTRAP_TOKEN=<secret> npm start -w @lukestanbery/jarvis-server
```

The server auto-disovers `packages/portal/dist` after a build (or use
`JARVIS_PORTAL_DIR` to override, or the empty string to disable portal
serving). Open `http://localhost:54321/` → `#/setup` on first run, then sign in.

## Layout

```
src/
├── main.tsx         # mount <App/>
├── App.tsx          # boot (session + CSRF), hash routing, auth guard
├── routes.ts        # tiny hash router (#/users #/devices #/sessions #/prefs #/setup #/login)
├── api.ts           # typed fetch client (CSRF header, 401 redirect, ApiError)
├── api.test.ts      # unit tests for the client
├── types.ts         # JSON shapes mirroring the server's REST payloads
├── styles.css
├── components/      # Layout (sidebar) + shared UI primitives
└── views/           # Login, Setup, Users, Devices, Sessions, Prefs
```

The `types.ts` shapes are the HTTP contract duplicated deliberately: the portal
ships as static assets with no Node-side dependency on the server or auth
packages, so the REST JSON payloads are the single source of truth.
