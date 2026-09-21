# @jarvis/cli — src architecture

This README explains how the CLI's source is organized. It is not a usage
guide — see the package `README.md` for install and usage instructions.

## Directory tree

```
src/
├── index.ts   # entry point (readline REPL loop)
├── client.ts  # ChatClient (WebSocket chat client)
├── config.ts  # server URL + session-file path from environment
├── session.ts # persistent conversation session id (~/.jarvis/session-id)
└── README.md  # this file
```

## File map

| File         | Responsibility                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`   | Entry point: readline REPL loop; forwards each line to the chat client and prints the streamed response as it arrives        |
| `client.ts`  | `ChatClient` — the WebSocket chat client: connects to the server, sends prompts, and emits typed events as frames stream in  |
| `config.ts`  | `getServerUrl()` → `JARVIS_SERVER_URL` (default `ws://localhost:54321/ws`); `getSessionFilePath()` → `JARVIS_SESSION_FILE`   |
| `session.ts` | `loadOrCreateSessionId()` → the id sent as `sessionId` on every prompt, persisted so the same thread resumes across restarts |

## Data flow

```
readline REPL (index.ts)
      │  line of text
      ▼
client.ts ChatClient.prompt(text, sessionId, handlers)
      │  {"prompt": "...", "sessionId": "..."}  over WebSocket → @jarvis/server /ws
      │  {"chunk": ...} / {"tool": ...} / {"toolResult": ...} frames … then {"done": true}
      ▼
index.ts onChunk → process.stdout.write(chunk)   (prints as it streams)
          onTool / onToolResult → logger to stderr (diagnostics, never stdout)
```

## Key decisions

- **Zero third-party runtime dependencies.** `ChatClient` uses Node's global
  `WebSocket`, so the package pulls in no third-party runtime deps; it speaks
  the JSON protocol defined in the shared first-party `@jarvis/protocol`
  package (parsing via its `parseFrame`, serialization via its
  `serializeRequest`; see `packages/protocol`).
- **Connect-on-demand.** The socket is opened lazily on the first `prompt()`
  call and reused, so a simple `jarvis` startup with no input costs nothing.
- **Wait for done.** If the REPL closes mid-response, the in-flight promise is
  awaited before exiting so the response is not truncated.
- **One promise at a time.** `prompt()` rejects if another prompt is already
  streaming on the same socket, so concurrent calls can't clobber each other's
  frame handlers.
- **One conversation, persisted.** `sessionId` comes from `session.ts`, which
  loads or creates `~/.jarvis/session-id`; deleting that file starts a fresh
  server-side thread.
- **Errors are user-facing text only.** Server error frames are surfaced as
  `Error: <message>` lines; the CLI never prints the server's `[INFO]`/`[DEBUG]`
  tracing logs.
