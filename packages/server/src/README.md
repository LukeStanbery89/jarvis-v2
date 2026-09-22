# @lukestanbery/jarvis-server — src architecture

This README explains how the server's source is organized. It is not a usage
guide — see the package `README.md` for prerequisites, endpoints, and
script commands.

## Directory tree

```
src/
├── index.ts       # entry point (bootstrap + listen)
├── app.ts         # Express app factory (health check)
├── config.ts      # LLM configuration from environment
├── agent.ts       # runAgent — owns the compiled graph + checkpointer (seam)
├── transport.ts   # toServerFrame — pure AgentEvent → wire-frame mapping
├── ws.ts          # /ws chat endpoint (server ↔ client transport)
├── auth/
│   ├── index.ts   # auth module exports (store + crypto + types + errors)
│   ├── store.ts   # AppStore seam + SqliteAppStore (app database ~/.jarvis/jarvis.sqlite)
│   ├── crypto.ts  # scrypt password hashing + device-token generation/hashing
│   ├── types.ts   # AppUser/AppDevice/AuthContext/ResolvedIdentity
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

| File                | Responsibility                                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`          | Entry point: bootstraps the agent graph (`initAgentGraph()` — creates `~/.jarvis` + the checkpoint store), builds the Express app, attaches the WS chat server, and listens on `PORT` (default `54321`)                                      |
| `app.ts`            | `createApp()` factory → the Express app serving `GET /` health check. Kept as a factory so tests can mount it via supertest without binding a port                                                                                           |
| `config.ts`         | `getLlmConfig()` → base URL, model, temperature, system prompt, turn limit, and checkpoint path; `getAppConfig()` → app database path, turn timeout, bootstrap token; `getServerPort()` → the listening port (default `54321`), all from env |
| `agent.ts`          | `initAgentGraph()` (eager, idempotent — called once at startup) builds the singleton graph + SQLite checkpointer; `runAgent(prompt, sessionId)` streams `AgentEvent`s. The only seam `ws.ts` imports; re-exports `AgentEvent`/`AgentGraph`   |
| `transport.ts`      | `toServerFrame(event)` → a pure, exhaustive `AgentEvent → ServerFrame` mapping so transports never see how the agent reports progress                                                                                                        |
| `ws.ts`             | `attachChatServer(httpServer)` → the `/ws` chat endpoint; validates frames, forwards events through `toServerFrame`, emits the terminal `done` frame                                                                                         |
| `auth/*`            | Accounts, device credentials, and the app database: `AppStore` (SQLite) + scrypt/token crypto + `AuthError`. The REST middleware and WS auth handshake resolve tokens through these seams                                                    |
| `llm/chatModel.ts`  | `createChatModel()` → the `ChatOpenAI` instance. Only module that knows `@langchain/openai`                                                                                                                                                  |
| `llm/agentGraph.ts` | `createAgentGraph()` → the `model ⇄ tools` StateGraph; `streamAgentTurn()` → runs one thread turn with a recursion limit, yielding `AgentEvent`s                                                                                             |
| `llm/event.ts`      | The `AgentEvent` union (`token`/`tool`/`toolResult`) — one turn's streamed output shape; also re-exported from the `agentGraph` and `agent` layers                                                                                           |
| `llm/tools/*`       | `tool()`-defined tools + the `tools` registry, bound by the model node and executed by the ToolNode                                                                                                                                          |

## Data flow

```
CLI / WebSocket client
      │  {"prompt": "...", "sessionId": "..."}
      ▼
ws.ts  handleMessage/watch   (parse + validate prompt + sessionId via @lukestanbery/jarvis-protocol)
      │  prompt, sessionId
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
  package README); `active` lives per-connection inside `attachChatServer`.
