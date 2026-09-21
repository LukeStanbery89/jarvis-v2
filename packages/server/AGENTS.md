# AGENTS.md

## Purpose

`@jarvis/server` — Express backend server for the J.A.R.V.I.S. AI assistant. Exposes a `GET /` health
endpoint and a WebSocket chat endpoint (`/ws`) that accepts prompts and streams back a response.

## Stack

- TypeScript (strict, ES2020, CommonJS)
- Express 5
- `ws` for WebSocket server
- LangChain (`@langchain/core` + `@langchain/openai`) for the model stack
- LangGraph (`@langchain/langgraph`) + SQLite checkpoints for the agent loop
- Logging via `@jarvis/logger` (Consola-based; see `src/logger.ts`)
- Tests via Vitest + supertest

## Scripts

Run from `packages/server`:

| Command             | Description                    |
| ------------------- | ------------------------------ |
| `npm run build`     | Compile TypeScript to `dist/`  |
| `npm run typecheck` | Type-check src and tests       |
| `npm run dev`       | Run the server with watch mode |
| `npm start`         | Run the compiled server        |
| `npm test`          | Run the test suite             |

## Endpoints

| Method | Path  | Description                         |
| ------ | ----- | ----------------------------------- |
| `GET`  | `/`   | Health-check, returns `Hello World` |
| `WS`   | `/ws` | Chat endpoint (WebSocket)           |

The server listens on port `54321` by default, overridable via `PORT`.

## Logging

Server logs go through the shared `@jarvis/logger` instance in `src/logger.ts`
(tag `server`): `YYYY-MM-DD HH:mm:ss [LEVEL] server — message` lines, colored
by level. Default level is `info`; set `JARVIS_LOG_LEVEL`
(`debug` | `info` | `warn` | `error`) to change it. Token-level tracing is
`debug` and stays hidden by default.

User prompts (`logger.sensitive`) and streamed tokens
(`logger.sensitiveDebug`) are sensitive payloads: redacted by default, logged
verbatim only under `NODE_ENV=development` (the `npm run dev` script sets
this). Production is redacted by default — never log prompt/response payloads
there; `JARVIS_LOG_SENSITIVE=full|redacted` overrides the mode.

## Chat protocol

JSON text frames on `/ws`:

- Client → Server: `{ "prompt": "<text>", "sessionId": "<id>" }` — sessionId
  (required, ≤128 chars) names the LangGraph conversation thread.
- Server → Client:
    - `{ "tool": { "name", "args" } }` and `{ "toolResult": { "name", "output" } }`
      frames while the agent calls tools,
    - then `{ "chunk": "<text>" }` … then `{ "done": true }`.
- Invalid input or model failure: `{ "error": "<message>" }` then `{ "done": true }`.
- A prompt sent while a previous response is still streaming is rejected with an error frame.

Chunks concatenate verbatim to the full response. Each prompt runs through a
**LangGraph agent** (`src/llm/agentGraph.ts`): a model node (bound to the tools
in `src/llm/tools/`) that can loop against a ToolNode, streamed in `messages`
mode and flattened into `AgentEvent`s (`token`/`tool`/`toolResult`) by
`streamAgentTurn`. Threads are persisted to a durable SQLite checkpointer
(`@langchain/langgraph-checkpoint-sqlite`) at `JARVIS_CHECKPOINT_PATH`; the
`sessionId` from the client maps one-to-one onto a thread id. The seam
`src/agent.ts` (`runAgent`) owns the singleton graph + checkpointer, and
`src/ws.ts` is the only module that touches it. `src/llm/chatModel.ts` is the
only module that knows `@langchain/openai`.
