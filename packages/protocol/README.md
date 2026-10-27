# @lukestanbery/jarvis-protocol

Shared chat wire-protocol types and framing for J.A.R.V.I.S. packages. This is
the **single source of truth** for the frames exchanged over the `/ws`
WebSocket: `@lukestanbery/jarvis-server`, `@lukestanbery/jarvis-cli`, and the web chat
client (`@lukestanbery/jarvis-web`) all import their frame types and
parsing/serialization from here instead of maintaining their own copies.

It is also the home of the **scheduled-job rule** (#90 phase 8): the recurrence
shape, its validation, and `nextOccurrence`. That is a widening of the package's
remit, decided on purpose — the server schedules with the same function the web
form previews with, so a preview cannot disagree with what will actually happen.
The same shared-home argument puts `plainText` here (#147): a notification body
is stored as Markdown, the web list renders it, and both the server's Web Push
payload and the page's OS notification need the same plain-text fallback.
It stays dependency-free: the maths is `Date` arithmetic behind an injectable
`Zone`, and `plainText` is a small regex-backed subset rather than a Markdown
parser.

## Install

```sh
npm install @lukestanbery/jarvis-protocol
```

## Scripts

| Script              | Description                        |
| ------------------- | ---------------------------------- |
| `npm run build`     | Compile TypeScript to `dist/`      |
| `npm run typecheck` | Type-check src and tests (no emit) |
| `npm test`          | Run the test suite (Vitest)        |

## API

| Export                                          | Description                                                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type ServerFrame`                              | Union of every frame the server sends to a chat client, including the out-of-turn `notification` (#139), `sessionTitle`, `sessionActivity`, and `sessionDeleted` (#122) frames                                                 |
| `type SessionTitleUpdate`                       | The out-of-turn `{ sessionId, title }` update carried by a `sessionTitle` frame after a turn                                                                                                                                   |
| `type SessionActivityUpdate`                    | The out-of-turn `{ sessionId }` nudge that another client settled a turn; the client refetches the thread                                                                                                                      |
| `type SessionDeletedUpdate`                     | The out-of-turn `{ sessionId }` notice that another client deleted the thread                                                                                                                                                  |
| `type NotificationFrame`                        | The proactive-notification payload (#139): `{ notification: { id, kind, class, priority, title, body?, createdAt, requiresAnswer? } }`                                                                                         |
| `type NotificationClass`                        | `"notification" \| "reminder" \| "timer"` (#90) — what kind of attention a notification asks for, derived from `NOTIFICATION_CLASSES`                                                                                          |
| `NOTIFICATION_CLASSES`                          | The class tuple the `NotificationClass` union and the parser both derive from                                                                                                                                                  |
| `type NotificationPriority`                     | `"low" \| "normal" \| "high" \| "urgent"` — display emphasis only (the _class_ decides quiet hours), derived from `NOTIFICATION_PRIORITIES`                                                                                    |
| `NOTIFICATION_PRIORITIES`                       | The priority tuple the `NotificationPriority` union and the parser both derive from                                                                                                                                            |
| `type ClientFrame`                              | Union of every frame a chat client sends: `AuthRequest \| ClientHello \| ChatPrompt \| ClientLocationFrame \| ClientCancelFrame`                                                                                               |
| `type ClientCapability`                         | `"markdown" \| "html" \| "image" \| "link" \| "audio" \| "notification" \| "sessionTitle" \| "sessionSync"` — what a client declares it can handle, derived from `CLIENT_CAPABILITIES`                                         |
| `type ChatMode`                                 | `"text" \| "voice"` — the chat mode a prompt runs under (absent = `"text"`), derived from `CHAT_MODES`                                                                                                                         |
| `CLIENT_CAPABILITIES`                           | The capability tuple (`readonly ["markdown", "html", "image", "link", "audio", "notification", "sessionTitle", "sessionSync"]`) the `ClientCapability` union and the parser both derive from                                   |
| `CHAT_MODES`                                    | The chat-mode tuple (`readonly ["text", "voice"]`) the `ChatMode` union and the parser both derive from                                                                                                                        |
| `REVOKED_TOKEN_ERROR`                           | The mid-prompt credential-rejection error text the server sends and both clients match (`"device token revoked; reconnect to re-authenticate"`)                                                                                |
| `interface AuthRequest`                         | The `auth` handshake: `{ type: "auth", token }`                                                                                                                                                                                |
| `interface ClientHello`                         | The capability announcement: `{ type: "hello", capabilities }`                                                                                                                                                                 |
| `interface AuthResult`                          | The `authResult` payload: `{ user, device }`                                                                                                                                                                                   |
| `interface ChatPrompt`                          | A client request: `{ prompt, sessionId, mode?, attachments? }`                                                                                                                                                                 |
| `interface ClientLocationFrame`                 | The device-location report (#31): `{ type: "location", lat, lon, label? }`                                                                                                                                                     |
| `interface ClientCancelFrame`                   | The turn cancellation (#84 P6): `{ type: "cancel" }`                                                                                                                                                                           |
| `interface ToolSource`                          | One original source on a `toolResult` (#199): `{ title, url }`, presentation-only                                                                                                                                              |
| `MAX_TOOL_SOURCES`                              | `20` — longest allowed `sources` list on a `toolResult`                                                                                                                                                                        |
| `MAX_TOOL_SOURCE_TITLE_LENGTH`                  | `300` — longest allowed source `title`                                                                                                                                                                                         |
| `MAX_TOOL_SOURCE_URL_LENGTH`                    | `2048` — longest allowed source `url`                                                                                                                                                                                          |
| `MAX_SESSION_ID_LENGTH`                         | `128` — longest allowed `sessionId`                                                                                                                                                                                            |
| `MAX_SESSION_TITLE_LENGTH`                      | `80` — longest allowed `sessionTitle` title                                                                                                                                                                                    |
| `MAX_PROMPT_LENGTH`                             | `16000` — longest allowed prompt text                                                                                                                                                                                          |
| `MAX_TOKEN_LENGTH`                              | `128` — longest allowed device `token`                                                                                                                                                                                         |
| `MAX_CAPABILITIES`                              | `16` — longest allowed `capabilities` list in a `hello` frame                                                                                                                                                                  |
| `MAX_CAPABILITY_LENGTH`                         | `16` — longest allowed single capability token                                                                                                                                                                                 |
| `MAX_ATTACHMENTS`                               | `4` — longest allowed `attachments` list in a prompt                                                                                                                                                                           |
| `MAX_ATTACHMENT_ID_LENGTH`                      | `32` — longest allowed single attachment id                                                                                                                                                                                    |
| `MAX_LOCATION_LABEL_LENGTH`                     | `64` — longest allowed optional place-name `label` in a `location` frame                                                                                                                                                       |
| `MAX_NOTIFICATION_ID_LENGTH`                    | `64` — longest allowed notification `id`                                                                                                                                                                                       |
| `MAX_NOTIFICATION_KIND_LENGTH`                  | `64` — longest allowed notification `kind` token                                                                                                                                                                               |
| `MAX_NOTIFICATION_TITLE_LENGTH`                 | `200` — longest allowed notification `title`                                                                                                                                                                                   |
| `MAX_NOTIFICATION_BODY_LENGTH`                  | `2000` — longest allowed notification `body`                                                                                                                                                                                   |
| `MAX_NOTIFICATION_ANSWER_LENGTH`                | `2000` — longest allowed answer to an answerable notification (the REST reply's bound)                                                                                                                                         |
| `MALFORMED_SERVER_FRAME`                        | User-facing wording thrown by `parseFrame` for unreadable (non-JSON / non-object) payloads; exported so clients reject with it verbatim (#106)                                                                                 |
| `type JobRepeat`                                | A job's recurrence rule (#90 phase 8): `{ every, interval, start, weekdays?, monthDays?, weekOrdinals?, ends? }` — `start` is the anchor and carries the wall clock, there is deliberately no separate `at`                    |
| `type RepeatFrequency`                          | `"minute" \| "hour" \| "day" \| "week" \| "month"`, derived from `REPEAT_FREQUENCIES`                                                                                                                                          |
| `type Weekday`                                  | `"su"`…`"sa"`, derived from `WEEKDAYS` (Sunday first, matching `Date#getUTCDay`; the week grid starts Monday)                                                                                                                  |
| `type Zone` / `LOCAL_ZONE`                      | The injectable clock seam: `offsetAt(utcMs)` in milliseconds east of UTC, defaulting to the runtime's own zone                                                                                                                 |
| `parseJobRepeat(value)`                         | Validates a rule from data, normalizing only what changes nothing (arrays deduplicated and sorted). Refuses days that can never exist ("the 32nd", "the 7th Monday") with a reason; a rule that merely _skips_ months is legal |
| `nextOccurrence(rule, now, zone?)`              | The first occurrence **strictly after `now`**, or `{ ok: false, reason: "ended" \| "never" }` — `ended` once the rule's `until` passed, `never` if the step ceiling holds nothing                                              |
| `describeRepeat(rule)`                          | The cadence in plain words ("every Monday, Tuesday and Saturday at 09:00", "on the 1st of every month at 09:00") — shared so the confirmation the model speaks, the page's row and the tools' `listJobs` line cannot disagree  |
| `repeatExhausted(rule, attempts)`               | Whether `ends.after` has been reached, given the firings the ledger has counted                                                                                                                                                |
| `MAX_REPEAT_INTERVAL`                           | `1000` — the largest `interval`                                                                                                                                                                                                |
| `MAX_REPEAT_ORDINAL`                            | `5` — the largest weekday-in-month ordinal ("the 5th Monday" is the most a month can hold)                                                                                                                                     |
| `MAX_REPEAT_STEPS`                              | `400` — how many periods `nextOccurrence` will step before answering `never`                                                                                                                                                   |
| `REPEAT_FREQUENCIES` / `WEEKDAYS`               | The tuples the unions and the validator both derive from                                                                                                                                                                       |
| `type JobGate`                                  | The deterministic check a job runs before its payload (#90 phase 8f): `{ tool, args, when }`, `when` fixed to `changed`                                                                                                        |
| `parseJobGate(value)`                           | Validates a gate from data, refusing unknown fields, a missing/over-long tool, non-object or oversized `args`, and any condition other than `changed`                                                                          |
| `gateKey(gate)`                                 | The gate's identity — `{ tool, args }` as canonical JSON with sorted object keys — stored beside every answer so two firings are compared only when they asked the same question                                               |
| `MAX_GATE_TOOL_LENGTH` / `MAX_GATE_ARGS_LENGTH` | The gate's bounds: `64` for the tool name, `2000` characters of serialized arguments (the identity is stored on every run row)                                                                                                 |
| `GATE_CONDITIONS`                               | The tuple `["changed"]` — the only comparison, deliberately                                                                                                                                                                    |
| `plainText(markdown)`                           | The notification body's plain-text fallback (#147): strips headings, list markers, emphasis, code fences, links/images and HTML, keeping readable labels and paragraph breaks for the OS Notification API and Web Push payload |
| `parseFrame(raw)`                               | Parses a server frame; throws on malformed/unrecognized payload                                                                                                                                                                |
| `normalizeToolSources(value)`                   | Vets and normalizes an optional `toolResult.sources` list (#199); invalid entries are dropped, never the result                                                                                                                |
| `parseClientMessage(raw)`                       | Parses + validates a client message into an `AuthRequest`, `ClientHello`, `ClientLocationFrame`, `ClientCancelFrame`, or `ChatPrompt`                                                                                          |
| `parseRequest(raw)`                             | Parses + validates a client request (non-empty strings, ≤128 id)                                                                                                                                                               |
| `serializeFrame(frame)`                         | Serializes a `ServerFrame` to wire JSON                                                                                                                                                                                        |
| `serializeRequest(p,sid,opts?)`                 | Serializes a client request to wire JSON; `opts` is `{ mode?, attachments? }`                                                                                                                                                  |
| `serializeAuth(token)`                          | Serializes an `auth` handshake to wire JSON                                                                                                                                                                                    |
| `serializeHello(caps[])`                        | Serializes a `hello` capability announcement to wire JSON                                                                                                                                                                      |
| `serializeCancel()`                             | Serializes a `cancel` turn cancellation to wire JSON (#84 P6)                                                                                                                                                                  |
| `serializeLocation(lat,lon,label?)`             | Serializes a `location` device report to wire JSON (#31)                                                                                                                                                                       |

## Plain-text notification fallback (#147)

A notification's `body` is model output and is stored **once**, as Markdown.
The web list and toast render it through `Markdown.tsx`; the OS Notification API
and the Web Push service worker cannot render Markdown, so they call
`plainText(body)` first. That keeps one source of truth: a scheduled prompt's
brief cannot read one way in `/notifications` and another in the lock-screen
popup. The function keeps line structure (paragraphs and `•` list items), turns
links and images into their labels/alt text (falling back to the URL), decodes
the common HTML entities the renderer would decode, and leaves identifiers such
as `snake_case` alone.

## Chat protocol

JSON text frames over `/ws`:

- Client → Server:
    - Optionally, **first frame only**: `{ "type": "auth", "token": "<device token>" }`
      — binds the socket to a user account. The server replies with a single
      `{ "authResult": { "user": "<name>", "device": "<name>" } }` frame. A
      client that never sends `auth` is treated as a **guest** (ephemeral,
      identity-independent chats).
    - Optionally, **first frame only**: `{ "type": "hello", "capabilities": ["markdown", "html", "image", "link", "audio", ...] }`
      — declares what the client can render in the response (`markdown`,
      `html`, `image`, `link`, `audio`, `notification`, `sessionTitle`,
      `sessionSync`, ≤16 tokens). The server stores the declaration
      for the socket's lifetime and conditions the agent's output on it; an
      empty list ("plain text only") is valid, and `hello` may precede `auth`.
    - `{ "prompt": "<text>", "sessionId": "<id>", "mode": "text" | "voice", "attachments": ["<id>", …] }` —
      `prompt` is 1–16,000 characters; `sessionId` (required, ≤128 chars)
      names the LangGraph conversation thread; `mode` is optional and defaults
      to `"text"`. `"text"` prompts
      are answered using the client's declared capabilities; `"voice"` prompts
      are always answered with plain conversational text. The server records
      the mode as the session's `kind` when it first claims the thread.
      `attachments` is an optional list of at most 4 ids (each ≤32 chars,
      unique) referencing images uploaded earlier via `POST /api/attachments`
      that this prompt is about; ids are opaque here — the server resolves
      them against its attachment store and rejects unknown or foreign ids.
    - Any time, refreshable (#31): `{ "type": "location", "lat": <number>, "lon": <number>, "label": "<place>" }`
      — the device's whereabouts (`lat` finite within ±90, `lon` within
      ±180, optional place-name `label` ≤64 chars) so location-aware tools
      (e.g. `getWeather`) can answer locationless questions without asking
      for a city. The latest frame wins for subsequent turns; the server
      keeps it for the socket's lifetime only and never persists it. Clients
      without a location source simply never send it.
    - Any time, idempotent (#84 P6): `{ "type": "cancel" }` — drop the
      socket's in-flight turn (barge-in or the stop button). The server
      aborts the model stream and the turn's spoken audio, releases the
      thread lock, and ends the turn with a terminal `done` — text already
      streamed stays in history, and no error frame is sent. With no turn
      in flight it is ignored (no reply).
- Server → Client:
    - `{ "tool": { "name", "args" } }` and `{ "toolResult": { "name", "output", "sources?" } }`
      frames while the agent calls tools. `sources` is an optional, bounded
      list of `{ title, url }` originals behind a search result (#199); it is
      presentation metadata, so a client that cannot render links can ignore
      it and the model-facing `output` remains the complete answer. Invalid or
      non-`http(s)` entries are dropped by the parser rather than failing the
      result,
    - then `{ "chunk": "<text>" }` … then `{ "done": true }`, then (for `audio`-capable sockets) `{ "audioStart": {...} }`, binary PCM chunks, `{ "audioEnd": {...} }`; and
      `{ "authResult": { "user", "device" } }` as the one-frame reply to an
      `auth` handshake,
    - and `{ "notification": { "id", "kind", "class", "priority", "title", "body", "createdAt", "requiresAnswer" } }`
      (#139) at **any** time — the one frame outside a turn. It is
      pushed to a user's open sockets when the server has something to report
      (a background job finished, a reminder came due, an agent needs an
      answer), so a client must handle it whether or not a prompt is in
      flight and must not treat it as the reply to one. `class` is the
      delivery policy (#90): a `timer` pierces quiet hours and rings until
      acknowledged, a `reminder` waits them out and is snoozable, and a
      `notification` is informational. Delivery is
      best-effort: the durable record lives behind `GET /api/notifications`,
      and a client matches by `id` so nothing renders twice.
    - `{ "sessionTitle": { "sessionId", "title" } }` (#122) at **any** time —
      an out-of-turn title update generated after a turn. It is sent only to a
      socket that declared the `sessionTitle` capability, carries the thread's
      wire `sessionId`, and never means the turn failed or restarted.
    - `{ "sessionActivity": { "sessionId" } }` and
      `{ "sessionDeleted": { "sessionId" } }` (#122 follow-up) at **any** time —
      another client settled a turn in the thread (refetch it) or deleted it
      (drop it). Both are sent only to sockets that declared `sessionSync`, and
      activity never echoes to the socket that produced the turn. Clients that
      do not declare the capability never receive either.
- Invalid input or model failure: `{ "error": "<message>" }` then `{ "done": true }`.

Frames are key-discriminated (no `type` field), with exception only for the
client `auth`, `hello`, `location`, and `cancel` frames, which carry a `type` so the
server can tell them apart from prompts. Chunks concatenate verbatim to the
full response. The error messages thrown by
`parseFrame`/`parseClientMessage`/`parseRequest` are user-facing on the CLI
side, so their wording must not drift. `MALFORMED_SERVER_FRAME` exports the
wording `parseFrame` throws for unreadable payloads so clients fail with the
canonical message instead of hand-copying it.

A machine-readable mirror of these frames lives in
`packages/contracts/spec/asyncapi.yaml` (AsyncAPI 3.1). **Keep this package and
that spec in lockstep**: any frame shape, rename, or bound change here must be
applied to the spec in the same change, and vice versa. The contracts package's
conformance tests parse the spec and validate representative real frames
against it, so a one-sided edit fails `npm run check`.

## Recurrence rules (#90 phase 8)

A job's `repeat` is a small closed object rather than an RRULE string, and the
parts that are easy to get wrong are decided here once:

- **`start` is the anchor.** Its wall clock is when a `day`/`week`/`month` series
  fires, and its instant is what a `minute`/`hour` interval aligns to. A job's
  `run_at` moves (a snooze, a quiet-hours deferral) but the anchor never does, so
  a series returns to its own clock afterwards. There is no separate `at`.
- **Sub-day intervals are exact arithmetic** ("every 24 hours" stays 24 hours and
  drifts against the local clock across DST, which is what saying _hours_ means);
  **calendar frequencies are wall-clock**, so a daily 08:00 is 08:00 in every
  season.
- **`weekdays`, `monthDays` and `weekOrdinals` compose as a union** inside a
  month: "every Monday and the 1st" is all the Mondays _plus_ the 1st (≈6 firings
  a month). RFC 5545's `BYDAY`+`BYMONTHDAY` intersects instead — the
  once-every-seven-months reading — and a phrasing that could mean either is a
  question for the model to ask, not a guess for this code to make.
- **Three tiers of impossible dates.** A day that _sometimes_ exists ("the 31st")
  clamps to the month's last day; an ordinal that _seldom_ exists ("the 5th
  Monday") is literal and simply skips months, so the caller can say when the next
  one is; something that _never_ exists is refused by `parseJobRepeat`.
- **DST is resolved explicitly, never left to the engine**: a wall clock the
  spring-forward swallowed resolves to the instant the clock jumped to, and one
  the autumn repeated yields both instants, earliest first — with `nextOccurrence`
  returning only what is strictly after `now`, so the first can never be a
  returned instant in the past. `Zone` exists so tests can pin this and a per-job
  timezone can arrive later without a rewrite.

## Gates (#90 phase 8f)

A gated job runs a check before its payload; this package owns the value's shape,
the server owns which tools may be checked (`scheduler/tools.ts`). Two decisions
live here because they are properties of the value rather than of a deployment:

- **One comparison: `changed`.** A richer condition is a predicate language or a
  model call, and half of one is worse than an honest refusal.
- **The identity is canonical.** `gateKey` sorts object keys at every level, so
  `{action, entity_id}` and `{entity_id, action}` are the same question; arrays
  keep their order, because `["get", "list"]` is not `["list", "get"]`. The
  runner stores it beside every answer, and a gate whose identity changed is
  treated as _no prior firing_ rather than as a change in the observed thing.

The shape is validated by `parseJobGate` at both ends — when a scheduling tool
stores it and when the runner reads it back — so a value that will not parse is
reported where it is read rather than discovered as a firing that did the wrong
thing.

## Notes for maintainers

- Zero runtime dependencies and no I/O — this package is deliberately types +
  parsing only, uncoupled from LangGraph, Express, and `ws`. `repeat.ts` is the
  same posture with arithmetic: pure functions, an injected `Zone`, and `now`
  passed in rather than read, so its DST behaviour is testable on any machine.
- Because consumers resolve through the compiled `dist` output (same as
  `@lukestanbery/jarvis-logger`), `@lukestanbery/jarvis-protocol` must be rebuilt after source edits and
  before type-checking dependents — run the root `npm run check` (which builds
  in dependency order) rather than a bare `tsc` in a dependent package.
