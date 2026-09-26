# @lukestanbery/jarvis-protocol

Shared chat wire-protocol types and framing for J.A.R.V.I.S. packages. This is
the **single source of truth** for the frames exchanged over the `/ws`
WebSocket: both `@lukestanbery/jarvis-server` and `@lukestanbery/jarvis-cli` import their frame types
and parsing/serialization from here instead of maintaining their own copies.

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

| Export                    | Description                                                               |
| ------------------------- | ------------------------------------------------------------------------- |
| `type ServerFrame`        | Union of every frame the server sends to a chat client                    |
| `type ClientFrame`        | Union of every frame a chat client sends: `AuthRequest \| ChatPrompt`     |
| `interface AuthRequest`   | The `auth` handshake: `{ type: "auth", token }`                           |
| `interface AuthResult`    | The `authResult` payload: `{ user, device }`                              |
| `interface ChatPrompt`    | A client request: `{ prompt, sessionId }`                                 |
| `MAX_SESSION_ID_LENGTH`   | `128` — longest allowed `sessionId`                                       |
| `MAX_TOKEN_LENGTH`        | `128` — longest allowed device `token`                                    |
| `parseFrame(raw)`         | Parses a server frame; throws on malformed/unrecognized payload           |
| `parseClientMessage(raw)` | Parses + validates a client message into an `AuthRequest` or `ChatPrompt` |
| `parseRequest(raw)`       | Parses + validates a client request (non-empty strings, ≤128 id)          |
| `serializeFrame(frame)`   | Serializes a `ServerFrame` to wire JSON                                   |
| `serializeRequest(p,sid)` | Serializes a client request to wire JSON                                  |
| `serializeAuth(token)`    | Serializes an `auth` handshake to wire JSON                               |

## Chat protocol

JSON text frames over `/ws`:

- Client → Server:
    - Optionally, **first frame only**: `{ "type": "auth", "token": "<device token>" }`
      — binds the socket to a user account. The server replies with a single
      `{ "authResult": { "user": "<name>", "device": "<name>" } }` frame. A
      client that never sends `auth` is treated as a **guest** (ephemeral,
      identity-independent chats).
    - `{ "prompt": "<text>", "sessionId": "<id>" }` — `sessionId`
      (required, ≤128 chars) names the LangGraph conversation thread.
- Server → Client:
    - `{ "tool": { "name", "args" } }` and `{ "toolResult": { "name", "output" } }`
      frames while the agent calls tools,
    - then `{ "chunk": "<text>" }` … then `{ "done": true }`, plus
      `{ "authResult": { "user", "device" } }` as the one-frame reply to an
      `auth` handshake.
- Invalid input or model failure: `{ "error": "<message>" }` then `{ "done": true }`.

Frames are key-discriminated (no `type` field), with a single exception: the
client `auth` handshake carries `type: "auth"` so the server can tell a
handshake from a prompt. Chunks concatenate verbatim to the full response. The
error messages thrown by `parseFrame`/`parseClientMessage`/`parseRequest` are
user-facing on the CLI side, so their wording must not drift.

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
