# @jarvis/cli

CLI text chat client for the Jarvis AI assistant.

## Prerequisites

- Node.js 18+
- npm

## Install

```sh
npm install -g @jarvis/cli
```

## Scripts

| Script          | Description                   |
| --------------- | ----------------------------- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev`   | Run the CLI in dev mode       |
| `npm start`     | Run the compiled CLI          |
| `npm test`      | Run the test suite (Vitest)   |

## Usage

Run directly from the repository (after `npm install`):

```sh
npm run dev
```

Or build and run the compiled output:

```sh
npm run build && node dist/index.js
```

When installed globally, it is available as the `jarvis` command:

```sh
jarvis
```

The CLI prints `Hello World` when it starts. This is a template project focused on the build/test workflow. Real chat functionality will be added later.
