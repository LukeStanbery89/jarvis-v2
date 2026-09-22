# J.A.R.V.I.S. — roadmap

The long-term picture for the `jarvis-v2` monorepo. Short log of where we are
today, the near-term work on the GitHub tracker, and the further-out ideas that
do not have issues of their own yet. Everything below is a direction, not a
commitment — re-verify the current code before trusting an old plan here.

## Today

A single-user assistant: one WS chat endpoint (`/ws`) streams LangGraph agent
turns to a CLI/REPL (and, soon, voice clients), backed by durable SQLite
checkpoints per `sessionId`. One persona, one checkpoint store, no per-human
identity. Transport internals were recentered in
[#13](https://github.com/LukeStanbery89/jarvis-v2/issues/13) (closed): a pure
`toServerFrame` adapter in the server, named render handlers in the CLI, and
`TurnOptions` for the agent loop.

## Near term

| Issue                                                        | What                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#22](https://github.com/LukeStanbery89/jarvis-v2/issues/22) | **User accounts, auth, multiple sessions.** Guest tier + identity tier, owner-managed accounts, per-device tokens, session lifecycle matrix, per-thread locks + turn timeout, WS auth handshake. The design is fully locked — this is the implementation plan. |
| [#23](https://github.com/LukeStanbery89/jarvis-v2/issues/23) | **Security hardening.** TLS, login rate limiting, bootstrap hygiene, audit cadence. We trust the LAN until this lands.                                                                                                                                         |
| [#24](https://github.com/LukeStanbery89/jarvis-v2/issues/24) | **Web admin portal.** Cookie-session browser UI over the REST API; extracts `@lukestanbery/jarvis-auth` from the server auth module.                                                                                                                           |
| [#25](https://github.com/LukeStanbery89/jarvis-v2/issues/25) | **Biometric (voice/face) auth.** Pluggable verifier seam built in #22, enrolled speaker ID for always-on devices.                                                                                                                                              |

Dependencies: #22 → #24 and #25 (they consume its seam and API); #24 wants
#23 (TLS/CSRF) before shipping cookies. This ordering is the plan of record.

## Further out (no issues yet)

Ideas worth keeping on the list; each becomes its own issue when it moves up.

- **Per-action auth classification.** Today auth is "endpoint requires
  identity or not." Future: classify each action's identity requirement (chat
  as guest vs. prefs vs. destructive ops) and encode it in the route metadata
  so new endpoints default to the safe side.
- **Mid-session onboarding / guest re-parenting.** Convert a live guest thread
  into an owned, persistent session when the user authenticates mid-chat — the
  approved "owner text persists" lifecycle needs this to be seamless.
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
