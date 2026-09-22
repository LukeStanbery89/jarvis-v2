# @lukestanbery/jarvis-logger

Shared leveled logging for J.A.R.V.I.S. packages. Wraps [Consola](https://consola.unjs.io)
behind a small API that emits timestamped, level-tagged lines.

## Install

```sh
npm install @lukestanbery/jarvis-logger
```

## Scripts

| Script              | Description                        |
| ------------------- | ---------------------------------- |
| `npm run build`     | Compile TypeScript to `dist/`      |
| `npm run typecheck` | Type-check src and tests (no emit) |
| `npm test`          | Run the test suite (Vitest)        |

## Usage

```ts
import { createLogger } from "@lukestanbery/jarvis-logger";

const logger = createLogger({ tag: "server" });

logger.info("J.A.R.V.I.S. server listening");
logger.debug("LLM token"); // hidden unless the level is debug
logger.warn("Rejecting duplicate prompt");
logger.error("LLM stream failed");

// Sensitive payloads (prompts, response text) go through these instead.
logger.sensitive("Streaming LLM response", "what is the weather?"); // info level
logger.sensitiveDebug("LLM token", "Hello"); // debug level
```

Every package creates one logger in a tiny `src/logger.ts` module (e.g.
`createLogger({ tag: "cli", stream: process.stderr })`) and imports it
wherever it logs.

## Output format

Each call emits one line shaped like
`YYYY-MM-DD HH:mm:ss [LEVEL] tag — message`, with the `[LEVEL]` label
colorized by level when colors are enabled:

```
2026-09-20 12:00:00 [INFO] server — J.A.R.V.I.S. server listening on http://localhost:54321
2026-09-20 12:00:00 [ERROR] server — LLM stream failed: model exploded
```

## Configuration

| Option      | Default                         | Description                                                                           |
| ----------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `tag`       | — (required)                    | Text attributed to every line, e.g. `"server"`                                        |
| `level`     | `JARVIS_LOG_LEVEL`, else `info` | `error` \| `warn` \| `info` \| `debug`                                                |
| `color`     | auto-detected                   | Colors the `[LEVEL]` label; honors `NO_COLOR` / `FORCE_COLOR`, on by default for TTYs |
| `stream`    | stdout/stderr by level          | Writable stream for all output (Node); see below                                      |
| `sensitive` | `redacted`                      | `"full"` renders payloads verbatim; `"redacted"` scrubs them (see below)              |

The `JARVIS_LOG_LEVEL` environment variable sets the level for every logger
that does not pass an explicit `level`. Debug output is the only level hidden
at the default; raise it with `JARVIS_LOG_LEVEL=debug`.

## Sensitive payloads

User prompts and model responses are real user data — never log them with the
plain `info`/`debug` methods. Use the two dedicated methods:

- `logger.sensitive(event, detail)` — always logged at `info` level. The
  `event` name stays visible in every environment; the `detail` is either
  appended verbatim or replaced with `[REDACTED]`.
- `logger.sensitiveDebug(event, detail)` — debug level, and emitted **only**
  in `"full"` mode. In redacted mode it never reaches the output at all, so
  payloads cannot leak even with `JARVIS_LOG_LEVEL=debug`.

Full mode: `2026-09-20 12:00:00 [INFO]  server — Streaming LLM response: what is the weather?`
`2026-09-20 12:00:00 [DEBUG] server — LLM token: Hello`
Redacted : `2026-09-20 12:00:00 [INFO]  server — Streaming LLM response: [REDACTED]`
(sensitiveDebug lines are omitted entirely)

### How the mode is chosen

Precedence: the `sensitive` option, then the `JARVIS_LOG_SENSITIVE` env var
(`full` | `redacted`), then the default:

| Environment                          | Mode       |
| ------------------------------------ | ---------- |
| `NODE_ENV=development`               | `full`     |
| anything else (incl. unset / `prod`) | `redacted` |

Payloads are **redacted by default** — an explicit opt-in is required to see
them. In practice that means development only: the server's `npm run dev`
starts with `NODE_ENV=development`; production deployments set nothing and are
safe by default.

## Streams and browsers

By default `info`/`debug` lines go to `process.stdout` and `warn`/`error`
lines to `process.stderr`, mirroring `console` semantics. Pass a single
`stream` (for example `process.stderr` in the CLI) to route everything to one
place. With no `stream` and no `process` (browsers), lines fall back to
`console[level]` and colors are disabled; no Node APIs run at module scope.

## Notes for maintainers

- Server and CLI depend on `@lukestanbery/jarvis-logger` normally (declared in their
  `package.json`). In this monorepo npm workspaces satisfies that dependency
  with a symlink to `packages/logger`, so **local edits are used in dev**;
  when `@lukestanbery/jarvis-server`/`@lukestanbery/jarvis-cli` are installed standalone, npm resolves
  `@lukestanbery/jarvis-logger` from the registry. The workspace symlink is a
  dev-only artifact and is never included in published tarballs.
- Because consumers resolve through the compiled `dist` output, `@lukestanbery/jarvis-logger`
  must be rebuilt after source edits and before type-checking dependents — run
  the root `npm run check` (which builds in dependency order) rather than a
  bare `tsc` in a dependent package.
- Where possible, keep the logged message a single rendered value: strings
  are printed verbatim, `Error`s as their `.message`, other objects as JSON.
