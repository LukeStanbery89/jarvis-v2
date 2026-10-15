# J.A.R.V.I.S. — roadmap

The long-term picture for the `jarvis-v2` monorepo. A short log of where we are
today, the near-term work on the GitHub tracker, and the further-out ideas that
do not have issues of their own yet. Everything below is a direction, not a
commitment — re-verify the current code before trusting an old plan here.

## Today

A small multi-user assistant. One WS chat endpoint (`/ws`) streams LangGraph
agent turns to a CLI REPL, the browser chat client at `/web`, and the admin
portal at `/`; conversations are durable SQLite checkpoints keyed by
`sessionId`. The auth stack ([#22](https://github.com/LukeStanbery89/jarvis-v2/issues/22)),
its security hardening ([#23](https://github.com/LukeStanbery89/jarvis-v2/issues/23)),
and the cookie portal ([#24](https://github.com/LukeStanbery89/jarvis-v2/issues/24))
are delivered, along with the web chat
client ([#12](https://github.com/LukeStanbery89/jarvis-v2/issues/12)),
server-side TTS
([#83](https://github.com/LukeStanbery89/jarvis-v2/issues/83)), and
client-side voice input — local STT, "Hey JARVIS" wake word, and barge-in
([#84](https://github.com/LukeStanbery89/jarvis-v2/issues/84)), and the
contract-first OpenAPI/AsyncAPI tooling
([#35](https://github.com/LukeStanbery89/jarvis-v2/issues/35)) covering both
API surfaces — specs, generated types, and lint/bundle/validate under
`packages/contracts`, its conformance gates riding the root `npm run check`.
Contract follow-ups get their own issues rather than a standing roll-up.

## Near term

Open work on the tracker, roughly in priority order.

| Issue                                                          | What                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [#102](https://github.com/LukeStanbery89/jarvis-v2/issues/102) | **Server hardening follow-ups** — WS crash/DoS guards, config NaN footgun, disable-revoke gap, cancel-vs-drain.    |
| [#103](https://github.com/LukeStanbery89/jarvis-v2/issues/103) | **AbortSignal through metered tools** — thread the turn's signal into the tool HTTP clients and dedupe them.       |
| [#104](https://github.com/LukeStanbery89/jarvis-v2/issues/104) | **Voice controller races** — first-press / begin / watch ordering fixes.                                           |
| [#105](https://github.com/LukeStanbery89/jarvis-v2/issues/105) | **Web robustness** — StrictMode-safe client construction, parked-prompt cancel, render batching.                   |
| [#106](https://github.com/LukeStanbery89/jarvis-v2/issues/106) | **CLI resilience** — survive malformed frames and unwritable state.                                                |
| [#107](https://github.com/LukeStanbery89/jarvis-v2/issues/107) | **Cross-package dedupe** — protocol drift-proofing, model caches, voice provider scaffolding, auth store helpers.  |
| [#109](https://github.com/LukeStanbery89/jarvis-v2/issues/109) | **Split `Chat.tsx`** — decompose the web god component into composable views and hooks.                            |
| [#110](https://github.com/LukeStanbery89/jarvis-v2/issues/110) | **Extract BargeWatch/WakeManager** from `VoiceController`.                                                         |
| [#100](https://github.com/LukeStanbery89/jarvis-v2/issues/100) | **Voice quality** — wake sensitivity knob, noise-robust transcription.                                             |
| [#65](https://github.com/LukeStanbery89/jarvis-v2/issues/65)   | **Rate-limit the `/ws` chat path** (guest sockets especially).                                                     |
| [#25](https://github.com/LukeStanbery89/jarvis-v2/issues/25)   | **Biometric (voice/face) auth** — the pluggable verifier seam exists; enrollment and always-on-device flow remain. |

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
- **Client packages beyond CLI.** New clients land as packages under
  `packages/` on the shared protocol/auth/voice seams — a browser extension
  ([#32](https://github.com/LukeStanbery89/jarvis-v2/issues/32)), and packaging
  the clients alongside the server
  ([#29](https://github.com/LukeStanbery89/jarvis-v2/issues/29)).
