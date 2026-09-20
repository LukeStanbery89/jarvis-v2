# AGENTS.md

## Purpose

`@jarvis/server` — Express backend server for the Jarvis AI assistant. Currently a template exposing a single `GET /` endpoint returning "Hello World"; real chat endpoints come later.

## Stack

- TypeScript (strict, ES2020, CommonJS)
- Express 5
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

| Method | Path | Response      |
| ------ | ---- | ------------- |
| `GET`  | `/`  | `Hello World` |

The server listens on port `54321` by default, overridable via `PORT`.
