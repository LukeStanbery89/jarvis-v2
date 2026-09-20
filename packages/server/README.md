# @jarvis/server

Express backend server for the Jarvis AI assistant. Accepts prompt messages over
WebSocket and streams a response back to the client.

## Prerequisites

- Node.js 18+
- npm

## Install

```sh
npm install @jarvis/server
```

## Scripts

| Script          | Description                    |
| --------------- | ------------------------------ |
| `npm run build` | Compile TypeScript to `dist/`  |
| `npm run dev`   | Run the server with watch mode |
| `npm start`     | Run the compiled server        |
| `npm test`      | Run the test suite (Vitest)    |

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

### Endpoints

| Method | Path  | Description                         |
| ------ | ----- | ----------------------------------- |
| `GET`  | `/`   | Health-check, returns `Hello World` |
| `WS`   | `/ws` | Chat endpoint (WebSocket)           |

### Chat protocol

Connect a WebSocket client to `/ws`, then exchange JSON text frames:

- Client → Server: `{ "prompt": "<your prompt>" }`
- Server → Client: one or more `{ "chunk": "<text>" }` frames, followed by `{ "done": true }`
- On invalid input: `{ "error": "<message>" }`, followed by `{ "done": true }`

Concatenate the `chunk` payloads verbatim to reconstruct the full response
(currently `Hello, World!`). Try it with the `@jarvis/cli` REPL.
