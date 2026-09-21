# @jarvis/server — src architecture

This README explains how the server's source is organized. It is not a usage
guide — see the package `README.md` for prerequisites, endpoints, and
script commands.

## Directory tree

```
src/
├── index.ts       # entry point (bootstrap + listen)
├── app.ts         # Express app factory (health check)
├── config.ts      # LLM configuration from environment
├── agent.ts       # runAgent — the brain seam (server ↔ model)
├── ws.ts          # /ws chat endpoint (server ↔ client transport)
├── llm/
│   ├── chatModel.ts  # createChatModel — the ONE @langchain/openai import site
│   ├── messages.ts   # buildMessages — thread shape ([System, Human])
│   └── tools/
│       ├── index.ts  # tool registry (defined, not yet bound)
│       ├── time.ts   # getCurrentTime tool
│       └── math.ts   # calculate tool (safe arithmetic parser)
└── README.md      # this file
```

## File map

| File               | Responsibility                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`         | Entry point: builds the Express app, attaches the WS chat server, and listens on `PORT` (default `54321`)                                          |
| `app.ts`           | `createApp()` factory → the Express app serving `GET /` health check. Kept as a factory so tests can mount it via supertest without binding a port |
| `config.ts`        | `getLlmConfig()` → base URL, model, temperature, stream-usage flag, and system prompt, from env (with LM Studio defaults)                          |
| `agent.ts`         | `runAgent(prompt)` → streams the model's response tokens. The only seam `ws.ts` imports from the model layer                                       |
| `ws.ts`            | `attachChatServer(httpServer)` → the `/ws` chat endpoint; pushes tokens to clients as frames (server → client direction)                           |
| `llm/chatModel.ts` | `createChatModel()` → the `ChatOpenAI` instance. Only module that knows `@langchain/openai`                                                        |
| `llm/messages.ts`  | `buildMessages(prompt)` → `[SystemMessage, HumanMessage]`. Single place the thread shape is defined                                                |
| `llm/tools/*`      | `tool()`-defined tools + the `tools` registry. Not bound to the model yet — consumed by LangGraph when tool execution lands                        |

## Data flow

```
CLI / WebSocket client
      │  {"prompt": "..."}
      ▼
ws.ts  handleMessage          (parse + validate the prompt frame)
      │  prompt
      ▼
ws.ts  streamTokensToSocket   ← streams chunk frames back to the socket
      │  for await ...
      ▼
agent.ts runAgent             (the brain seam: model composition)
      │  messages
      ▼
llm/messages.ts buildMessages ([SystemMessage, HumanMessage])
      ▼
llm/chatModel.ts createChatModel  (ChatOpenAI → LM Studio /chat/completions)
      │  content deltas
      ▼
LM Studio (OpenAI-compatible server)
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
- **Every request is a fresh single-turn thread** — a `SystemMessage` primer
  (persona, verbosity) followed by the user's `HumanMessage`. Multi-turn
  memory and real conversation state are deferred to the LangGraph phase;
  `buildMessages` is where that history threads in.
- **Tools are defined, not yet bound.** Tool execution is an agent _loop_
  (model → tool call → `ToolMessage` → model), which LangGraph will own. The
  registry (`llm/tools/`) is the payload that phase consumes, so tools are
  `tool()`-factory style with zod schemas — the idiomatic, LangGraph-ready form.
- **One active response per connection.** A second prompt arriving while a
  response is streaming is rejected with an error frame (see protocol in the
  package README); `active` lives per-connection inside `attachChatServer`.
