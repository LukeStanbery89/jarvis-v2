# @lukestanbery/jarvis-cli — src architecture

This README explains how the CLI's source is organized. It is not a usage
guide — see the package `README.md` for install and usage instructions.

## Directory tree

```
src/
├── index.ts        # entry point (readline REPL loop, login/logout/new commands)
├── client.ts       # ChatClient (WebSocket chat client)
├── render.ts       # renderHandlers — prints the streamed response
├── config.ts       # server URL + state-file paths + origin key from environment
├── session.ts      # per-identity conversation session ids (~/.jarvis/session-id)
├── credentials.ts  # per-origin login tokens (~/.jarvis/credentials.json, 0600)
├── login.ts        # REST login + interactive credential prompts
├── privateFs.ts    # local 0700/0600 filesystem helpers (mirror of server fs.ts)
└── README.md       # this file
```

## File map

| File             | Responsibility                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`       | Entry point: readline REPL loop; forwards each line to the chat client, delegating stream rendering to `renderHandlers`; owns the `login`/`logout`/`new` commands and the echo-suppressed password prompt                  |
| `client.ts`      | `ChatClient` — the WebSocket chat client: connects to the server, authenticates on the socket's first frame with a stored token when present, sends prompts, and emits typed events as frames stream in                    |
| `render.ts`      | `renderHandlers` — the named `PromptHandlers` for a text session: chunks to stdout, tool calls/results as stderr diagnostics                                                                                               |
| `config.ts`      | `getServerUrl()` → `JARVIS_SERVER_URL`; `getSessionFilePath()` → `JARVIS_SESSION_FILE`; `getCredentialsFilePath()` → `JARVIS_CREDENTIALS_FILE`; `serverOrigin()` → the stable per-server key                               |
| `session.ts`     | Per-identity session-id store: `loadSessionIds()` → the `{guest, users}` store; `sessionIdFor(ids, identity)` → the id sent as `sessionId` on every prompt (never rotates); `rotateActiveSession()` for the explicit `new` |
| `credentials.ts` | `load/save/clearCredentials(origin)` — the per-origin device-token store, written atomically at `0600`                                                                                                                     |
| `login.ts`       | `loginRequest()` — `POST /api/auth/login` over REST with mapped error messages; `askLoginDetails()` — interactive prompts                                                                                                  |
| `privateFs.ts`   | `ensurePrivateDir()` — tightens dirs this process creates to `0700` (local mirror of the server package's `fs.ts` semantics)                                                                                               |

## Data flow

```
readline REPL (index.ts)
      │  line of text (or a login/logout command)
      ▼
client.ts ChatClient.prompt(text, sessionId, handlers)
      │  1. (with a stored token) {"type":"auth","token":...} → authResult verdict
      │  2. {"prompt": "...", "sessionId": "..."}  over WebSocket → @lukestanbery/jarvis-server /ws
      │     {"chunk": ...} / {"tool": ...} / {"toolResult": ...} frames … then {"done": true}
      ▼
render.ts renderHandlers  onChunk → process.stdout.write(chunk)   (prints as it streams)
                          onTool / onToolResult → logger to stderr (diagnostics, never stdout)

login command (index.ts → login.ts)
      │  username + password (echo suppressed) + device name
      ▼
login.ts loginRequest → POST {origin}/api/auth/login → { user, device, token }
      ▼
credentials.ts saveCredentials(origin, …) → ~/.jarvis/credentials.json (0600, atomic write)
      ▼
index.ts closes the socket + switches to the login identity's remembered thread (per-identity slots, no rotation)

rejection recovery (client.ts → index.ts)
      │  server rejects the token ("invalid device token" at connect, "device token revoked" mid-prompt)
      ▼
index.ts onAuthRejected → clearCredentials(origin) + drop to the guest slot → next prompt runs as a guest
```

## Key decisions

- **Zero third-party runtime dependencies.** `ChatClient` uses Node's global
  `WebSocket`, so the package pulls in no third-party runtime deps; it speaks
  the JSON protocol defined in the shared first-party `@lukestanbery/jarvis-protocol`
  package (parsing via its `parseFrame`, serialization via its
  `serializeRequest`; see `packages/protocol`).
- **Connect-on-demand.** The socket is opened lazily on the first `prompt()`
  call and reused, so a simple `jarvis` startup with no input costs nothing.
- **Authenticate before the first prompt.** When a stored token exists it is
  sent as the socket's first frame, and the client waits for the server's
  `authResult` verdict (or an error, or a 5s timeout) before the socket is
  usable — the REPL only ever sees an authenticated or guest socket. A
  rejected token falls back to a guest socket and reports the rejection
  through `onAuthRejected` so the entry point can clear the stored credential;
  a timeout keeps the stored token on disk (the CLI never learned it was bad)
  but stops re-sending it on that socket. The confirmed identity is exposed
  via `getIdentity()`.
- **Wait for done.** If the REPL closes mid-response, the in-flight promise is
  awaited before exiting so the response is not truncated.
- **One promise at a time.** `prompt()` rejects if another prompt is already
  streaming on the same socket, so concurrent calls can't clobber each other's
  frame handlers.
- **One conversation per identity, persisted.** The active `sessionId` comes
  from `session.ts`, which keeps one thread slot per identity (`guest` plus one
  per logged-in account) in `~/.jarvis/session-id`; deleting that file resets
  every thread. Because the server's strict ownership policy never re-parents
  a thread across identities, login/logout **switch slots** (resuming the
  remembered thread) instead of rotating, and a deliberate fresh conversation
  is the `new` command (`rotateActiveSession`).
- **Credentials live locally, keyed per server.** `credentials.ts` stores one
  device token per server origin in a single JSON file written atomically
  (temp file + rename) at mode `0600`, inside a directory tightened to `0700`
  when this process creates it. A malformed file is ignored (warn + null),
  never fatal. The token is never logged.
- **Errors are user-facing text only.** Server error frames are surfaced as
  `Error: <message>` lines; the CLI never prints the server's `[INFO]`/`[DEBUG]`
  tracing logs.
