# jarvis-v2

AI-powered assistant monorepo.

## Packages

| Package                                  | Description                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| [packages/protocol](./packages/protocol) | Shared chat wire-protocol types + framing (`@lukestanbery/jarvis-protocol`) |
| [packages/server](./packages/server)     | Express backend server with WebSocket chat (`@lukestanbery/jarvis-server`)  |
| [packages/cli](./packages/cli)           | WebSocket chat REPL client (`@lukestanbery/jarvis-cli`)                     |
| [packages/logger](./packages/logger)     | Shared leveled, timestamped logging (`@lukestanbery/jarvis-logger`)         |

## Getting started

Install all workspace dependencies from the repository root:

```sh
npm install
```

## Architecture

The server answers every prompt with a **LangGraph agent** rather than a bare
LLM: the model can call tools inside a bounded loop before streaming its final
answer, and each client-supplied `sessionId` maps to a conversation thread that
is persisted to a SQLite checkpoint file. The CLI keeps its `sessionId` in
`~/.jarvis/session-id`, so conversations survive both CLI and server restarts.
The wire protocol those two packages speak over `/ws` is defined **once** in
`@lukestanbery/jarvis-protocol`; see each package's README for details.

During development the workspace packages resolve each other **through the
workspace symlinks** npm creates in `node_modules` — edit source in
`packages/logger`, for example, and `@lukestanbery/jarvis-server` picks up the change as
soon as you rebuild (see `npm run build`). When a package is published and
installed standalone, npm resolves its `@lukestanbery/jarvis-*` dependencies normally from
the registry; the workspace symlink is a dev-only artifact and never ships in
a published tarball.

## Commands

| Command                | Description                               |
| ---------------------- | ----------------------------------------- |
| `npm run build`        | Build all packages                        |
| `npm run typecheck`    | Type-check all packages (src + tests)     |
| `npm test`             | Run all package tests                     |
| `npm run check`        | Build + typecheck + test + format check   |
| `npm run format`       | Auto-format all files with Prettier       |
| `npm run format:check` | Verify formatting without modifying files |

## Code style

Formatting is enforced with [Prettier](https://prettier.io) using the rules in
[`.prettierrc.json`](./.prettierrc.json):

- Strings use double quotes
- Indentation is 4 spaces

Format-on-save is configured for VS Code (`.vscode/settings.json`, requires the
[Prettier extension](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode))
and for the OpenCode editor (`opencode.json`). Run `npm run check` in CI
to enforce type-checking, tests, and formatting.
