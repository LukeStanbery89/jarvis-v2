# jarvis-v2

AI-powered assistant monorepo.

## Packages

| Package                              | Description                                                   |
| ------------------------------------ | ------------------------------------------------------------- |
| [packages/server](./packages/server) | Express backend server with WebSocket chat (`@jarvis/server`) |
| [packages/cli](./packages/cli)       | WebSocket chat REPL client (`@jarvis/cli`)                    |

## Getting started

Install all workspace dependencies from the repository root:

```sh
npm install
```

## Commands

| Command                | Description                               |
| ---------------------- | ----------------------------------------- |
| `npm run build`        | Build all packages                        |
| `npm test`             | Run all package tests                     |
| `npm run format`       | Auto-format all files with Prettier       |
| `npm run format:check` | Verify formatting without modifying files |

## Code style

Formatting is enforced with [Prettier](https://prettier.io) using the rules in
[`.prettierrc.json`](./.prettierrc.json):

- Strings use double quotes
- Indentation is 4 spaces

Format-on-save is configured for VS Code (`.vscode/settings.json`, requires the
[Prettier extension](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode))
and for the OpenCode editor (`opencode.json`). Run `npm run format:check` in CI to enforce.
