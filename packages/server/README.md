# @jarvis/server

Express backend server for the J.A.R.V.I.S. AI assistant. Accepts prompt messages over
WebSocket and streams a response back to the client.

## Prerequisites

- Node.js 18+
- npm
- A running OpenAI-compatible inference server. [LM Studio](https://lmstudio.ai) is the
  default — launch it, load a model, and start its local server on port `1234`.

## Install

```sh
npm install @jarvis/server
```

## Scripts

| Script              | Description                        |
| ------------------- | ---------------------------------- |
| `npm run build`     | Compile TypeScript to `dist/`      |
| `npm run typecheck` | Type-check src and tests (no emit) |
| `npm run dev`       | Run the server with watch mode     |
| `npm start`         | Run the compiled server            |
| `npm test`          | Run the test suite (Vitest)        |

## Usage

```sh
npm run dev
```

The server listens on port `54321` by default (chosen from the IANA
dynamic/private range to avoid collisions with other services). Override with
the `PORT` environment variable:

```sh
PORT=8080 npm run dev
```

### Configuration

The model is reached via LangChain (`@langchain/openai`) pointed at an
OpenAI-compatible endpoint. Everything is configurable through environment
variables:

| Variable               | Default                                                                         | Description                                           |
| ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `LLM_BASE_URL`         | `http://localhost:1234/v1`                                                      | OpenAI-compatible base URL                            |
| `LLM_MODEL`            | `qwen/qwen3-4b-2507`                                                            | Model served by the server                            |
| `LLM_TEMPERATURE`      | `0`                                                                             | Sampling temperature                                  |
| `LLM_SYSTEM_PROMPT`    | `You are J.A.R.V.I.S., a helpful, personal AI assistant. ...` (concise persona) | System message priming every conversation thread      |
| `JARVIS_LOG_LEVEL`     | `info`                                                                          | Log verbosity: `debug` \| `info` \| `warn` \| `error` |
| `JARVIS_LOG_SENSITIVE` | `auto`                                                                          | Force sensitive payload logging: `full` \| `redacted` |

```sh
LLM_MODEL=some-other-model npm run dev
```

### Logging

Log lines look like
`2026-09-20 12:00:00 [INFO] server — message`, colored by level. Reach the
level filter with `JARVIS_LOG_LEVEL` (default `info`).

User prompts and streamed response tokens are treated as **sensitive
payloads** and are redacted by default (the data is replaced by `[REDACTED]`,
token tracing suppressed). Payloads are logged verbatim only in development:
`npm run dev` sets `NODE_ENV=development`. Production deployments (any other
`NODE_ENV`, including unset) stay redacted even if `JARVIS_LOG_LEVEL=debug` is
forced. Override either way with `JARVIS_LOG_SENSITIVE=full|redacted`. The
option is provided by `@jarvis/logger` (`sensitive` / `sensitiveDebug`).

### Endpoints

| Method | Path  | Description                         |
| ------ | ----- | ----------------------------------- |
| `GET`  | `/`   | Health-check, returns `Hello World` |
| `WS`   | `/ws` | Chat endpoint (WebSocket)           |

### Chat protocol

Connect a WebSocket client to `/ws`, then exchange JSON text frames:

- Client → Server: `{ "prompt": "<your prompt>" }`
- Server → Client: one or more `{ "chunk": "<text>" }` frames, followed by `{ "done": true }`
- On invalid input or model failure: `{ "error": "<message>" }`, followed by `{ "done": true }`
- Sending a new prompt while a response is still streaming is rejected with an
  `in progress` error frame.

Concatenate the `chunk` payloads verbatim to reconstruct the full response, streamed
from the configured LLM. Try it with the `@jarvis/cli` REPL.
