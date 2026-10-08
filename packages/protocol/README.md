# @lukestanbery/jarvis-protocol

Shared chat wire-protocol types and framing for J.A.R.V.I.S. packages. This is
the **single source of truth** for the frames exchanged over the `/ws`
WebSocket: `@lukestanbery/jarvis-server`, `@lukestanbery/jarvis-cli`, and the web chat
client (`@lukestanbery/jarvis-web`) all import their frame types and
parsing/serialization from here instead of maintaining their own copies.

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

| Export                              | Description                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `type ServerFrame`                  | Union of every frame the server sends to a chat client                                                                                |
| `type ClientFrame`                  | Union of every frame a chat client sends: `AuthRequest \| ClientHello \| ChatPrompt \| ClientLocationFrame \| ClientCancelFrame`      |
| `type ClientCapability`             | `"markdown" \| "html" \| "image" \| "link"` — a render guarantee a client declares                                                    |
| `type ChatMode`                     | `"text" \| "voice"` — the chat mode a prompt runs under (absent = `"text"`)                                                           |
| `interface AuthRequest`             | The `auth` handshake: `{ type: "auth", token }`                                                                                       |
| `interface ClientHello`             | The capability announcement: `{ type: "hello", capabilities }`                                                                        |
| `interface AuthResult`              | The `authResult` payload: `{ user, device }`                                                                                          |
| `interface ChatPrompt`              | A client request: `{ prompt, sessionId, mode?, attachments? }`                                                                        |
| `interface ClientLocationFrame`     | The device-location report (#31): `{ type: "location", lat, lon, label? }`                                                            |
| `interface ClientCancelFrame`       | The turn cancellation (#84 P6): `{ type: "cancel" }`                                                                                  |
| `MAX_SESSION_ID_LENGTH`             | `128` — longest allowed `sessionId`                                                                                                   |
| `MAX_TOKEN_LENGTH`                  | `128` — longest allowed device `token`                                                                                                |
| `MAX_CAPABILITIES`                  | `16` — longest allowed `capabilities` list in a `hello` frame                                                                         |
| `MAX_CAPABILITY_LENGTH`             | `16` — longest allowed single capability token                                                                                        |
| `MAX_ATTACHMENTS`                   | `4` — longest allowed `attachments` list in a prompt                                                                                  |
| `MAX_ATTACHMENT_ID_LENGTH`          | `32` — longest allowed single attachment id                                                                                           |
| `MAX_LOCATION_LABEL_LENGTH`         | `64` — longest allowed optional place-name `label` in a `location` frame                                                              |
| `parseFrame(raw)`                   | Parses a server frame; throws on malformed/unrecognized payload                                                                       |
| `parseClientMessage(raw)`           | Parses + validates a client message into an `AuthRequest`, `ClientHello`, `ClientLocationFrame`, `ClientCancelFrame`, or `ChatPrompt` |
| `parseRequest(raw)`                 | Parses + validates a client request (non-empty strings, ≤128 id)                                                                      |
| `serializeFrame(frame)`             | Serializes a `ServerFrame` to wire JSON                                                                                               |
| `serializeRequest(p,sid,opts?)`     | Serializes a client request to wire JSON; `opts` is `{ mode?, attachments? }`                                                         |
| `serializeAuth(token)`              | Serializes an `auth` handshake to wire JSON                                                                                           |
| `serializeHello(caps[])`            | Serializes a `hello` capability announcement to wire JSON                                                                             |
| `serializeCancel()`                 | Serializes a `cancel` turn cancellation to wire JSON (#84 P6)                                                                         |
| `serializeLocation(lat,lon,label?)` | Serializes a `location` device report to wire JSON (#31)                                                                              |

## Chat protocol

JSON text frames over `/ws`:

- Client → Server:
    - Optionally, **first frame only**: `{ "type": "auth", "token": "<device token>" }`
      — binds the socket to a user account. The server replies with a single
      `{ "authResult": { "user": "<name>", "device": "<name>" } }` frame. A
      client that never sends `auth` is treated as a **guest** (ephemeral,
      identity-independent chats).
    - Optionally, **first frame only**: `{ "type": "hello", "capabilities": ["markdown", "image", ...] }`
      — declares what the client can render in the response (`markdown`,
      `html`, `image`, `link`, ≤16 tokens). The server stores the declaration
      for the socket's lifetime and conditions the agent's output on it; an
      empty list ("plain text only") is valid, and `hello` may precede `auth`.
    - `{ "prompt": "<text>", "sessionId": "<id>", "mode": "text" | "voice", "attachments": ["<id>", …] }` —
      `sessionId` (required, ≤128 chars) names the LangGraph conversation
      thread; `mode` is optional and defaults to `"text"`. `"text"` prompts
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
    - `{ "tool": { "name", "args" } }` and `{ "toolResult": { "name", "output" } }`
      frames while the agent calls tools,
    - then `{ "chunk": "<text>" }` … then `{ "done": true }`, plus
      `{ "authResult": { "user", "device" } }` as the one-frame reply to an
      `auth` handshake.
- Invalid input or model failure: `{ "error": "<message>" }` then `{ "done": true }`.

Frames are key-discriminated (no `type` field), with exception only for the
client `auth`, `hello`, and `location` frames, which carry a `type` so the
server can tell them apart from prompts. Chunks concatenate verbatim to the
full response. The error messages thrown by
`parseFrame`/`parseClientMessage`/`parseRequest` are user-facing on the CLI
side, so their wording must not drift.

A machine-readable mirror of these frames lives in
`packages/contracts/spec/asyncapi.yaml` (AsyncAPI 3.1). **Keep this package and
that spec in lockstep**: any frame shape, rename, or bound change here must be
applied to the spec in the same change, and vice versa. The contracts package's
conformance tests parse the spec and validate representative real frames
against it, so a one-sided edit fails `npm run check`.

## Notes for maintainers

- Zero runtime dependencies and no I/O — this package is deliberately types +
  parsing only, uncoupled from LangGraph, Express, and `ws`.
- Because consumers resolve through the compiled `dist` output (same as
  `@lukestanbery/jarvis-logger`), `@lukestanbery/jarvis-protocol` must be rebuilt after source edits and
  before type-checking dependents — run the root `npm run check` (which builds
  in dependency order) rather than a bare `tsc` in a dependent package.
