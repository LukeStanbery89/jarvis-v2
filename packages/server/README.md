# @jarvis/server

Express backend server for the Jarvis AI assistant.

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

| Method | Path | Response      |
| ------ | ---- | ------------- |
| `GET`  | `/`  | `Hello World` |

This is a template project focused on the build/test workflow. Real chat endpoints will be added later.
