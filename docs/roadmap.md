# J.A.R.V.I.S. — roadmap

The long-term picture for the `jarvis-v2` monorepo. Short log of where we are
today, the near-term work on the GitHub tracker, and the further-out ideas that
do not have issues of their own yet. Everything below is a direction, not a
commitment — re-verify the current code before trusting an old plan here.

## Today

A small multi-user assistant: one WS chat endpoint (`/ws`) streams LangGraph
agent turns to a CLI/REPL, a browser chat client at `/web` (and, soon, voice
clients), backed by durable SQLite checkpoints per `sessionId`. Auth from
[#22](https://github.com/LukeStanbery89/jarvis-v2/issues/22) is delivered:
device-token handshake on `/ws`, an account/session ledger in the app
database, per-thread locks + turn timeout, and a `/api` REST layer
(bootstrap, login, devices, users, sessions). Transport internals were
recentered in [#13](https://github.com/LukeStanbery89/jarvis-v2/issues/13)
(closed): a pure `toServerFrame` adapter in the server, named render handlers
in the CLI, and `TurnOptions` for the agent loop.

## Near term

| Issue                                                        | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#22](https://github.com/LukeStanbery89/jarvis-v2/issues/22) | **User accounts, auth, multiple sessions.** ✅ Delivered: guest/owned sessions, role-based accounts, per-device rotating tokens, device revocation enforced on live sockets, strict session ownership, REST `/api`, per-thread locks + turn timeout, WS auth handshake, and the CLI's authenticated connect + `login`/`logout` (token sent as the socket's first frame; rejected tokens self-heal to a guest).                                                                                                                                                                |
| [#23](https://github.com/LukeStanbery89/jarvis-v2/issues/23) | **Security hardening.** ✅ LAN items landed: login/bootstrap rate limiting + lockout, single-use bootstrap token, optional in-node TLS + HTTP→HTTPS upgrade, `JARVIS_HOST` binding, `~/.jarvis` `0700`/`0600` permissions, and CSRF nonces on the cookie portal. Remaining: pre-internet posture review, audit cadence.                                                                                                                                                                                                                                                       |
| [#24](https://github.com/LukeStanbery89/jarvis-v2/issues/24) | **Web admin portal.** ✅ Delivered: cookie-session browser UI over the REST API at `/` (accounts, devices, sessions, prefs), with per-session CSRF nonces; extracted `@lukestanbery/jarvis-auth` from the server auth module.                                                                                                                                                                                                                                                                                                                                                 |
| [#25](https://github.com/LukeStanbery89/jarvis-v2/issues/25) | **Biometric (voice/face) auth.** Pluggable verifier seam built in #22, enrolled speaker ID for always-on devices.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [#35](https://github.com/LukeStanbery89/jarvis-v2/issues/35) | **API contracts (OpenAPI + AsyncAPI).** ✅ Delivered: contract-first, machine-checkable specs for the REST `/api` surface and the `/ws` chat channel — `packages/contracts` holds the YAML, generated TS types, lint/validate tooling, conformance tests, and docs (endpoint tables + static HTML reference on GitHub Pages). The `/ws` frame shapes mirror `@lukestanbery/jarvis-protocol` and are pinned by conformance tests.                                                                                                                                              |
| [#12](https://github.com/LukeStanbery89/jarvis-v2/issues/12) | **New JARVIS client: web (in progress).** A browser chat client (`packages/web`) served at `/web`: forced sign-in (`POST /api/auth/login`, device token in localStorage), ChatGPT-style conversation management (sidebar from `GET /api/sessions`, client-side localStorage transcripts keyed by `sessionId`), and streaming markdown/tables/images rendering over `/ws` with the `hello` capability announcement and per-prompt `mode` (`"text"`; `"voice"` yields plain conversational text — a voice UI is future). Remaining: hardening/UX polish from post-merge review. |

Dependencies: #22 → #24 and #25 (they consume its seam and API); #24 wants
#23 (TLS/CSRF) before shipping cookies. This ordering is the plan of record.

## Further out (no issues yet)

Ideas worth keeping on the list; each becomes its own issue when it moves up.

- **Per-action auth classification.** Today auth is "endpoint requires
  identity or not." Future: classify each action's identity requirement (chat
  as guest vs. prefs vs. destructive ops) and encode it in the route metadata
  so new endpoints default to the safe side.
- **Mid-session onboarding / guest re-parenting.** Convert a live guest thread
  into an owned, persistent session when the user authenticates mid-chat. ⚠️
  Scoping constraint from the auth hardening review: a socket's identity is
  fixed at its first frame, so a _different_ principal claiming a guest's
  thread is a confidentiality break (ship only as a same-principal re-parent,
  e.g. a claim challenge owned by the guest's own account).
- **Voice-idle guest TTL.** Guest voice threads delete on socket close today;
  add a short idle timer so a dropped mic doesn't hold a thread forever.
- **Turn suspension / resumption.** The per-turn timeout in #22 aborts
  long turns; a future mechanism could _suspend_ the turn at the timeout and
  resume from the checkpoint instead of discarding it.
- **Multi-process.** The single-process server is fine at household scale;
  document what breaks first (per-thread locks and the app DB lock) when a
  second instance appears.
- **Client packages beyond CLI.** Voice and other clients land as new packages
  under `packages/`, per the repo convention; the auth seam in #22 keeps them
  from forking the verifier logic.
