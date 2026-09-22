# @lukestanbery/jarvis-server — src architecture

This README explains how the server's source is organized. It is not a usage
guide — see the package `README.md` for prerequisites, endpoints, and
script commands.

## Directory tree

```
src/
├── index.ts       # entry point (composition root: bootstrap + attach WS)
├── app.ts         # Express app factory (health check + /api mount)
├── listener.ts    # transport seam: HTTP(S) server + TLS/redirect listener
├── config.ts      # LLM configuration from environment
├── agent.ts       # runAgent — owns the compiled graph + checkpointer (seam)
├── transport.ts   # toServerFrame — pure AgentEvent → wire-frame mapping
├── ws.ts          # /ws chat endpoint (server ↔ client transport)
├── http/
│   ├── middleware.ts   # requireAuth / requireOwner — fill req.jarv from a bearer token
│   └── authRoutes.ts   # createAuthRouter — the /api management router
├── auth/
│   ├── index.ts   # auth module exports (store + crypto + credential + types + errors)
│   ├── store.ts   # AppDatabase seam + SqliteAppDatabase (app database ~/.jarvis/jarvis.sqlite)
│   ├── crypto.ts  # scrypt password hashing + device-token generation/hashing (the primitives)
│   ├── credential.ts  # CredentialVerifier seam — hash/verify + dummy-hash timing equalization
│   ├── types.ts   # AppUser/AppDevice/AuthContext (guest|authed union)/ResolvedIdentity/AppSession/SessionKind
│   ├── errors.ts  # AuthError
│   └── README.md  # auth module guide
├── llm/
│   ├── chatModel.ts   # createChatModel — the ONE @langchain/openai import site
│   ├── agentGraph.ts  # createAgentGraph + streamAgentTurn (the LangGraph loop)
│   ├── toolCallTracker.ts # folds streamed messages into AgentEvents
│   └── tools/
│       ├── index.ts  # tool registry (bound to the model by the graph)
│       ├── time.ts   # getCurrentTime tool
│       └── math.ts   # calculate tool (safe arithmetic parser)
└── README.md      # this file
```

## File map

| File                 | Responsibility                                                                                                                                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`           | Entry point: bootstraps the agent graph (`initAgentGraph()` — creates `~/.jarvis` + the checkpoint store), builds the Express app, hands it to the listener seam, and attaches the WS chat server. A thin composition root — no transport code here                                                                                     |
| `app.ts`             | `createApp(store, appConfig)` factory → Express app: `GET /` health check, `express.json()`, the `/api` router, and a JSON-parser error handler. Kept as a factory so tests can mount it via supertest without binding a port                                                                                                           |
| `listener.ts`        | `createJarvisServer(webApp, settings)` → a running `{ server, scheme, url }`; owns plain-HTTP vs. in-node TLS, the cert/key reads, the half-set-TLS guard, the bind + `listen()`, and (in TLS mode) the cleartext redirect listener on `PORT + 1`/`JARVIS_HTTP_REDIRECT_PORT`. `validateRedirectPort` keeps the port-math unit-testable |
| `config.ts`          | `getLlmConfig()` → base URL, model, temperature, system prompt, turn limit, and checkpoint path; `getAppConfig()` → app database path, turn timeout, bootstrap token, TLS/redirect settings; `getServerPort()` → the listening port (default `54321`), all from env                                                                     |
| `agent.ts`           | `initAgentGraph()` (eager, idempotent — called once at startup) builds the singleton graph + SQLite checkpointer; `runAgent(prompt, sessionId)` streams `AgentEvent`s. The only seam `ws.ts` imports; re-exports `AgentEvent`/`AgentGraph`                                                                                              |
| `transport.ts`       | `toServerFrame(event)` → a pure, exhaustive `AgentEvent → ServerFrame` mapping so transports never see how the agent reports progress                                                                                                                                                                                                   |
| `ws.ts`              | `attachChatServer(httpServer, store, options)` → the `/ws` chat endpoint; resolves the optional first-frame `auth` handshake (guest fallback), validates prompt frames, claims sessions in the ledger, enforces the per-thread lock + turn timeout, forwards events through `toServerFrame`, emits the terminal `done` frame            |
| `auth/*`             | Accounts, device credentials, and the app database: `AppDatabase` (SQLite) + the `CredentialVerifier` seam (scrypt/token crypto) + `AuthError`. The REST middleware, credential endpoints, and WS auth handshake resolve tokens through these seams                                                                                     |
| `http/middleware.ts` | `requireAuth(store)` (Bearer device token → `req.jarv`, 401 otherwise) + `requireOwner` (403 for non-owners); `AuthedRequest` derives from the `AuthContext` union so `authed(req).jarv` is the guaranteed non-null identity                                                                                                            |
| `http/authRoutes.ts` | `createAuthRouter(store, appConfig, credentials?)` → the `/api` router: `bootstrap`, `auth/login`, `me`, `devices`, `users`, `sessions`; maps `AuthError` codes to HTTP statuses; `credentials` defaults to the scrypt-backed `CredentialVerifier` seam                                                                                 |
| `llm/chatModel.ts`   | `createChatModel()` → the `ChatOpenAI` instance. Only module that knows `@langchain/openai`                                                                                                                                                                                                                                             |
| `llm/agentGraph.ts`  | `createAgentGraph()` → the `model ⇄ tools` StateGraph; `streamAgentTurn()` → runs one thread turn with a recursion limit, yielding `AgentEvent`s                                                                                                                                                                                        |
| `llm/event.ts`       | The `AgentEvent` union (`token`/`tool`/`toolResult`) — one turn's streamed output shape; also re-exported from the `agentGraph` and `agent` layers                                                                                                                                                                                      |
| `llm/tools/*`        | `tool()`-defined tools + the `tools` registry, bound by the model node and executed by the ToolNode                                                                                                                                                                                                                                     |

## Data flow

```
CLI / WebSocket client
      │  first frame?  {"type":"auth","token":...} → authResult (or error + guest)
      │  then          {"prompt": "...", "sessionId": "..."}
      ▼
ws.ts  handleMessage/watch   (resolve handshake via store; parse + validate prompt via @lukestanbery/jarvis-protocol;
      │                       claim session in ledger, take per-thread lock, arm turn timer)
      │  prompt, sessionId + AuthContext (guest | authed user/device)
      ▼
agent.ts runAgent            (the brain seam: graph + checkpointer)
      │  AgentEvents: token | tool | toolResult
      ▼
llm/agentGraph.ts streamAgentTurn  (thread seeded from the checkpointer)
      │  messages
      ▼
llm/chatModel.ts createChatModel  (ChatOpenAI → LM Studio /chat/completions)
      │  content deltas + tool calls
      ▼
LM Studio (OpenAI-compatible server)

… and the streamed AgentEvents flow back out, mapped by
transport.ts toServerFrame (pure event → frame) and emitted by
ws.ts sendFrame as chunk / tool / toolResult frames, then {"done": true}.
```

The boundary between the transport and the model stack is `agent.ts`; the
tests mock `runAgent` (`test/ws.test.ts`) so the chat endpoint is exercised
without a live model.

## Key decisions

- **Transport and model never mix.** `ws.ts` only imports `runAgent`; clients
  can be swapped without touching the model layer and vice-versa.
- **One provider import site.** `llm/chatModel.ts` is the only module that
  imports `@langchain/openai`. Swapping backends means changing one factory,
  not the whole pipeline.
- **Conversations are LangGraph threads.** Every `sessionId` maps to a
  persisted thread in the SQLite checkpointer; a fresh thread is primed with
  the system prompt + the user prompt, existing threads just receive the new
  `HumanMessage`. Multi-turn memory therefore survives server restarts.
- **The model loops through tools.** Tool calls are the model's job to
  request and the ToolNode's to run, bounded by `JARVIS_AGENT_MAX_TURNS`. The
  streamed `messages`-mode output is flattened into `AgentEvent`s
  (`token`/`tool`/`toolResult`) by `streamAgentTurn` + the `ToolCallTracker`,
  so transports never see graph internals.
- **One active response per connection.** A second prompt arriving while a
  response is streaming is rejected with an error frame (see protocol in the
  package README); `active` lives per-connection inside `attachChatServer`. On
  top of that, a **per-thread lock** rejects concurrent turns on the same
  `sessionId` across sockets, and every turn runs under a hard **turn
  timeout** (`options.turnTimeoutMs`, default `DEFAULT_TURN_TIMEOUT_MS`) so the
  lock always drains — the timeout error is emitted by the timer and the
  in-flight generator is `return()`d.
- **Sessions are a ledger, not just threads.** Each prompt claims its
  `sessionId` in the app database (`AppDatabase.claimSession`, atomic
  `INSERT … ON CONFLICT DO NOTHING`) tagging it guest vs owned and
  `text`/`voice`. Guest sockets' claimed sessions are deleted when the socket
  closes (`guestThreads` tracked per connection); owned sessions persist for
  the REST layer to list/delete. `touchSession` keeps `last_active_at` current;
  `threadId` is unique so a session maps one-to-one onto a checkpoint thread.
- **Auth is a first-frame handshake.** A client may authenticate with a device
  token on its first frame (`{ type: "auth", token }` → one `authResult`
  frame); any other first frame, or none, runs the socket as a guest. The
  token is hashed (`SHA-256`) before `AppDatabase.resolveTokenHash` compares it — no
  raw secret is ever logged or persisted.
