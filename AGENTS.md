# AGENTS.md

## Stack

- TypeScript (strict, ES2020, CommonJS)
- Monorepo managed with npm workspaces
- Builds via `tsc`
- Tests via Vitest
- Formatting via Prettier (double quotes, 4-space indent)
- Runtime: Node.js 24+

## Architecture

npm workspaces monorepo with independent, publishable packages under `packages/`:

- `packages/server` (`@jarvis/server`) — Express backend server. Exposes `GET /` (health check) and a WebSocket chat endpoint at `/ws` that accepts a prompt and streams back `Hello, World!`. Real AI responses come later.
- `packages/cli` (`@jarvis/cli`) — WebSocket chat REPL. Forwards prompts to the server and prints the streamed response. Uses Node's global `WebSocket` (no runtime deps).

Each package has its own `package.json`, `tsconfig.json` (extends `tsconfig.base.json`), `src/` (or `server` + per-package `test/`), and `README.md`.

Future client types (voice, etc.) should be added as new packages under `packages/`.

## Scripts

Run from the repository root:

| Command                | Description                               |
| ---------------------- | ----------------------------------------- |
| `npm install`          | Install all workspace dependencies        |
| `npm run build`        | Build all packages with `tsc`             |
| `npm test`             | Run all package test suites (Vitest)      |
| `npm run format`       | Auto-format all files with Prettier       |
| `npm run format:check` | Verify formatting without modifying files |

## Conventions

- Code style is enforced by Prettier (see `.prettierrc.json`): double quotes, 4-space indent.
- Format-on-save is configured for VS Code (`.vscode/settings.json`) and OpenCode (`opencode.json`).
- Each package is independently publishable to npm (`npm pack --dry-run` from the package to verify contents).
- Do not commit changes unless the user explicitly asks. Never stage, commit, or push without an explicit instruction to do so.

## Rule: keep README files current

Whenever a change makes any `README.md` stale or outdated, update it in the same change. READMEs describe purpose, usage, scripts, and endpoints — keep them accurate, especially when adding/removing scripts, dependencies, endpoints, or package structure.
