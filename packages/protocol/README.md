# @jarvis/protocol

Shared chat wire-protocol types and framing for J.A.R.V.I.S. packages. This is
the **single source of truth** for the frames exchanged over the `/ws`
WebSocket: both `@jarvis/server` and `@jarvis/cli` import their frame types
and parsing/serialization from here instead of maintaining their own copies.

## Install

```sh
npm install @jarvis/protocol
```

## Scripts

| Script              | Description                        |
| ------------------- | ---------------------------------- |
| `npm run build`     | Compile TypeScript to `dist/`      |
| `npm run typecheck` | Type-check src and tests (no emit) |
| `npm test`          | Run the test suite (Vitest)        |

## API

| Export                    | Description                                                      |
| ------------------------- | ---------------------------------------------------------------- |
| `type ServerFrame`        | Union of every frame the server sends to a chat client           |
| `interface ChatPrompt`    | A client request: `{ prompt, sessionId }`                        |
| `MAX_SESSION_ID_LENGTH`   | `128` — longest allowed `sessionId`                              |
| `parseFrame(raw)`         | Parses a server frame; throws on malformed/unrecognized payload  |
| `parseRequest(raw)`       | Parses + validates a client request (non-empty strings, ≤128 id) |
| `serializeFrame(frame)`   | Serializes a `ServerFrame` to wire JSON                          |
| `serializeRequest(p,sid)` | Serializes a client request to wire JSON                         |

## Chat protocol

JSON text frames over `/ws`:

- Client → Server: `{ "prompt": "<text>", "sessionId": "<id>" }` — `sessionId`
  (required, ≤128 chars) names the LangGraph conversation thread.
- Server → Client:
    - `{ "tool": { "name", "args" } }` and `{ "toolResult": { "name", "output" } }`
      frames while the agent calls tools,
    - then `{ "chunk": "<text>" }` … then `{ "done": true }`.
- Invalid input or model failure: `{ "error": "<message>" }` then `{ "done": true }`.

Frames are key-discriminated (no `type` field); chunks concatenate verbatim
to the full response. The error messages thrown by `parseFrame`/
`parseRequest` are user-facing on the CLI side, so their wording must not
drift.

## Notes for maintainers

- Zero runtime dependencies and no I/O — this package is deliberately types +
  parsing only, uncoupled from LangGraph, Express, and `ws`.
- Because consumers resolve through the compiled `dist` output (same as
  `@jarvis/logger`), `@jarvis/protocol` must be rebuilt after source edits and
  before type-checking dependents — run the root `npm run check` (which builds
  in dependency order) rather than a bare `tsc` in a dependent package.
