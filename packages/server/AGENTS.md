# AGENTS.md

## Purpose

`@jarvis/server` — Express backend server for the Jarvis AI assistant. Exposes a `GET /` health
endpoint and a WebSocket chat endpoint (`/ws`) that accepts prompts and streams back a response.

## Stack

- TypeScript (strict, ES2020, CommonJS)
- Express 5
- `ws` for WebSocket server
- Tests via Vitest + supertest

## Scripts

Run from `packages/server`:

| Command         | Description                    |
| --------------- | ------------------------------ |
| `npm run build` | Compile TypeScript to `dist/`  |
| `npm run dev`   | Run the server with watch mode |
| `npm start`     | Run the compiled server        |
| `npm test`      | Run the test suite             |

## Endpoints

| Method | Path  | Description                         |
| ------ | ----- | ----------------------------------- |
| `GET`  | `/`   | Health-check, returns `Hello World` |
| `WS`   | `/ws` | Chat endpoint (WebSocket)           |

The server listens on port `54321` by default, overridable via `PORT`.

## Chat protocol

JSON text frames on `/ws`:

- Client → Server: `{ "prompt": "<text>" }`
- Server → Client: `{ "chunk": "<text>" }` … then `{ "done": true }`
- Invalid input: `{ "error": "<message>" }` then `{ "done": true }`

Chunks concatenate verbatim to the full response (currently `Hello, World!`). Streaming
tokens are produced by `src/stream.ts`; the WebSocket handling lives in `src/ws.ts`.
