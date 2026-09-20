# @jarvis/cli — src architecture

This README explains how the CLI's source is organized. It is not a usage
guide — see the package `README.md` for install and usage instructions.

## Directory tree

```
src/
├── index.ts   # entry point (readline REPL loop)
├── client.ts  # ChatClient (WebSocket chat client)
├── config.ts  # server URL from environment
└── README.md  # this file
```

## File map

| File        | Responsibility                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`  | Entry point: readline REPL loop; forwards each line to the chat client and prints the streamed response as it arrives       |
| `client.ts` | `ChatClient` — the WebSocket chat client: connects to the server, sends prompts, and emits typed events as frames stream in |
| `config.ts` | `getServerUrl()` → the server's WebSocket URL from `JARVIS_SERVER_URL` (default `ws://localhost:54321/ws`)                  |

## Data flow

```
readline REPL (index.ts)
      │  line of text
      ▼
client.ts ChatClient.prompt(text, onChunk)
      │  {"prompt": "..."}  over WebSocket → @jarvis/server /ws
      │  {"chunk": "..."} frames … then {"done": true}
      ▼
index.ts onChunk → process.stdout.write(chunk)   (prints as it streams)
```

## Key decisions

- **Zero runtime dependencies.** `ChatClient` uses Node's global `WebSocket`,
  so the package has no runtime deps — it speaks the JSON protocol defined by
  `@jarvis/server` directly (see `parseFrame` for the single frame-shape check).
- **Connect-on-demand.** The socket is opened lazily on the first `prompt()`
  call and reused, so a simple `jarvis` startup with no input costs nothing.
- **Wait for done.** If the REPL closes mid-response, the in-flight promise is
  awaited before exiting so the response is not truncated.
- **Errors are user-facing text only.** Server error frames are surfaced as
  `Error: <message>` lines; the CLI never prints the server's `[INFO]`/`[DEBUG]`
  tracing logs.
