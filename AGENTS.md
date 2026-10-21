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

- `packages/protocol` (`@lukestanbery/jarvis-protocol`) — Shared chat wire protocol: frame types, `auth`/`hello`/`prompt`/`location`/`cancel`, bounds/constants, and the only parse/serialize implementation. Single source of truth for `/ws`; zero runtime deps.
- `packages/auth` (`@lukestanbery/jarvis-auth`) — Auth core: better-sqlite3 DB + ledgers, password/device-token crypto, `CredentialVerifier` seam, row-ownership policy, `AuthError`, and private-filesystem helpers. Consumed by the server.
- `packages/server` (`@lukestanbery/jarvis-server`) — Express backend with `GET /health`, REST `/api`, the web app at `/` (the front door), the admin portal at `/admin`, and WS `/ws` streaming local LLM responses. Includes server-side TTS (`src/tts`), cancellable turns (`cancel`), local STT model serving (`src/stt`), and a scheduler for fire-at-T jobs (`src/scheduler`, #90) whose model-facing tools live in `src/llm/tools/jobs.ts` (`setTimer`/`remindMe`/`scheduleTask`/`schedulePrompt`/`listJobs`/`cancelJob`/`snoozeReminder` — each tool owns its job's delivery class; `remindMe`/`scheduleTask`/`schedulePrompt` also take a recurrence rule and state it back, and all three creating tools take an optional read-only **gate** that must find a change before the payload runs — a declined firing is a `skipped` run row, costs nothing and announces nothing, and is the only way a job that runs a tool or a prompt may repeat faster than every 15 minutes (a message job spends nothing, and since 9a each of its firings supersedes the previous announcement, so it may repeat every minute)); a job may carry a recurrence rule (`JobRepeat` from `@lukestanbery/jarvis-protocol`, phase 8), in which case each firing re-arms the same row at its next occurrence — one row, whose `run_at` is always the next one — and a per-account daily budget (`JARVIS_JOB_MODEL_RUNS_PER_DAY`, persisted in the auth DB) bounds the model calls a schedule can spend; and a sandboxed coding surface whose credential broker can run as a sidecar on an internal network with a public-only egress proxy (#141).
- `packages/cli` (`@lukestanbery/jarvis-cli`) — WebSocket chat REPL. Forwards prompts to the server and prints the streamed response. Uses Node's global `WebSocket`; depends only on `@lukestanbery/jarvis-logger` + `@lukestanbery/jarvis-protocol` (no third-party runtime deps).
- `packages/logger` (`@lukestanbery/jarvis-logger`) — Shared leveled logging wrapping Consola. Emits `YYYY-MM-DD HH:mm:ss [LEVEL] tag — message` lines, colored by level; default level `info` (`silent` under a test runner), overridable via `JARVIS_LOG_LEVEL`.
- `packages/portal` (`@lukestanbery/jarvis-portal`) — Private React 19 + Vite 8 SPA served at `/admin` (the admin surface; the app's front door is `packages/web` at `/`); talks only to REST API with cookie sessions + CSRF nonces. Not CommonJS, not `tsc`-built: `vite build` → static `dist/`.
- `packages/web` (`@lukestanbery/jarvis-web`) — Private React 19 + Vite 8 SPA served at `/` (the app's front door since #90 phase 6a; the admin portal moved to `/admin`, the chat is at `/chat`, and the old `/web` 301s to `/chat`); `/` is the dashboard (clock, what is coming up from `GET /api/jobs`, the unread count) under a top bar that collapses to a hamburger under 60rem — its own measured breakpoint, since three state chips need just over that — where the links and the gear become a Settings item in the menu, while the chat's thread list becomes a drawer and the wordmark centres at 48rem and every phone-reachable control is at least 44 px there (the shell otherwise holds at 96 rem and centres, so the field becomes the margin), and routing is a small store over `window.location` in `src/router.ts` (in-app `AppLink`s push history and swap the view without a reload, while a modified click still opens a real tab); `src/AppShell.tsx` owns the app-level state (socket, transcript, audio, notifications, prefs, jobs, and — since 6d — the microphone, the location share and the one turn runner both the composer and a wake match submit through; the voice session's `noteResponseFrame`/`noteAudioStarted` feed its frame handler, so the frame bus is gone) so a navigation cannot drop a stream, silence a wake word or reconnect, and a view receives it as one `AppState`; the pages are the dashboard at `/`, the chat at `/chat`, and the job/notification lists at `/timers`, `/reminders` and `/notifications` — all three lists create and edit through one modal form (`views/app/JobForm.tsx`: a timer by length, a reminder by moment, an edit always by moment, and the class always the page's) over the shared row (`views/app/JobRow.tsx`) and the shared form lifecycle (`hooks/useJobPage.ts`), a job may carry a recurrence rule (the form's **Repeats** control, whose live line previews the cadence and the next firing through the same protocol function the server schedules with), the two job lists keep a collapsed **Recent** history of their settled rows (cancelled ones included — they leave no record anywhere else), and the notifications page (7d) carries the notification class's own **Scheduled** half — its pending jobs and any note written there — above the records, each of which offers a **Runs** disclosure (`views/app/JobRuns.tsx`: the job's attempts, fetched through its `jobId` only once opened, and "the job is gone" when the id a list read before the prune still holds has since been pruned away) — since 8f that disclosure sits on every **job row** too (owed and Recent, so `/timers` and `/reminders` gain it, and a gated firing that declined, which announces nothing, is visible only there; a `skipped` attempt shows the gate's answer under it through `describeRun`, a conditional row says `checks first`, and an empty disclosure reports how many times a plain reminder fired rather than claiming nothing was recorded), while every list offers cancel and the reminders offer **snooze**, where a snooze is one request that moves the reminder _and_ settles the announcement it answered (`snoozed`), and the floating toast (`views/app/Toast.tsx`) carries that snooze wherever the user is; forced sign-in, conversation management, streaming over `/ws` with `markdown`/`html`/`image`/`link`/`audio` capabilities, voice (`mode: "voice"`) via `packages/voice` (the wake word listens on every page, a match with no conversation open mints one and goes to it), barge-in, and location sharing. A settings panel (gear in the top bar since 6d, #143) hosts the account's notification preferences (`notify.*` via `/api/prefs`) beside this browser's own controls, and says which is which. The app sits on a hand-rolled particle field (#146) that widens its breathe with the spoken answer's loudness, and its surfaces are frosted-glass panes, both switchable per browser in the settings panel's **Appearance** group (the field unmounts when off, so its loop stops; the glass flattens one composed `--glass-filter` variable and darkens the tint, leaving the layout identical), and the top bar's menu carries every page plus an outward link to the admin portal, with a left icon rail replacing the bar's links from 80 rem. Notifications are class-aware (#90 phase 4): a fired `timer` rings in a modal overlay (`views/app/TimerRing.tsx`) with Stop as its one exit — `selectAlerts` in `src/notifications.ts` decides what rings, and `selectToasts` decides what reaches the floating toast stack (`views/app/Toast.tsx`: reminders, or timers that failed or were missed, newest first, up to `TOAST_LIMIT`) on every page, the alarm is Web Audio on the shared player, and the audio context unlocks on the first gesture of any kind, not just the mic. The bar carries the app-state chips (connection, microphone, location), each only while it has something to say. Not CommonJS, not `tsc`-built: `vite build` → static `dist/`.
- `packages/voice` (`@lukestanbery/jarvis-voice`) — Shared voice-input abstractions (Stt/WakeWord/VAD seams), `reduceVoice` state machine, `VoiceController` orchestrator, Web Speech + Vosk STT providers, browser VAD, openWakeWord wake provider, barge-in watch. A wake session is fed the detector's **live, phrase-free command stream** (`WakeCallbacks.onCommandAudio`, cut at the detector score's onset) instead of a replayed look-back ring, so the wake phrase's audio cannot reach the recognizer — the invariant #121 established; `stripWakePhrase` is only a safety net, and the wake→command corpus under `test/fixtures/` is the acceptance gate for changes on that path (`npm run probe:wake` reproduces the score/cut timeline offline). Consumed by `packages/web`; zero mandatory runtime deps. Peer: `@lichess-org/vosk-browser`; optional deps: `openwakeword-web`, `onnxruntime-web`.
- `packages/contracts` (`@lukestanbery/jarvis-contracts`) — Contract-first OpenAPI 3.1 (REST) and AsyncAPI 3.1 (WS) specs, generated TS types, lint/bundle/validate tooling, conformance tests, and docs. Specs mirror `@lukestanbery/jarvis-protocol` and are the source of truth.

Each package has its own `package.json`, `tsconfig.json` (extends `tsconfig.base.json`), `src/` (or `server` + per-package `test/`), and `README.md`.

Future client types (voice, etc.) should be added as new packages under `packages/`.

## Scripts

Run from the repository root:

| Command                | Description                                                            |
| ---------------------- | ---------------------------------------------------------------------- |
| `npm install`          | Install all workspace dependencies                                     |
| `npm run build`        | Build all packages (`tsc`, plus `vite build` for the portal and web)   |
| `npm run typecheck`    | Type-check all packages (src + tests)                                  |
| `npm test`             | Run all package test suites (Vitest)                                   |
| `npm run test:scripts` | Run the root tooling tests under `scripts/` (Vitest)                   |
| `npm run check`        | Deps + lint + build + typecheck + test + format check                  |
| `npm run check:deps`   | Verify no package imports an undeclared dependency                     |
| `npm run lint`         | Lint all TS/TSX sources with ESLint                                    |
| `npm run lint:fix`     | Lint and autofix all TS/TSX sources with ESLint                        |
| `npm run graph:update` | Rebuild the graphify knowledge graph (AST-only, no LLM cost)           |
| `npm run graph:health` | Report graphify structural health (duplicate/dangling/self-loop edges) |
| `npm run format`       | Auto-format all files with Prettier                                    |
| `npm run format:check` | Verify formatting without modifying files                              |

## Conventions

- **Declare what you import.** A package must list every module it imports at
  runtime in its own `package.json` — `src/` imports in `dependencies`,
  `peerDependencies`, or `optionalDependencies`; test imports may also use
  `devDependencies`. An undeclared import still type-checks (when `@types/*` is
  present) and still tests green (npm workspaces hoist a sibling's copy into the
  root `node_modules`), so nothing else catches it. `npm run check:deps` fails the
  build on a violation; run it when you add an import. Subpath imports
  (`@lukestanbery/jarvis-auth/testing`) attribute to their owning package, and Node
  builtins are exempt in both the `node:`-prefixed and bare spellings.
- Code style is enforced by Prettier (see `.prettierrc.json`): double quotes, 4-space indent.
- Format-on-save is configured for VS Code (`.vscode/settings.json`) and OpenCode (`opencode.json`).
- Every new or modified function/module ships (or updates) a JSDoc `/** ... */` comment describing purpose, callers, and behavior; keep existing doc comments current whenever behavior changes.
- Logging: route all logging through `@lukestanbery/jarvis-logger`, creating one logger per package via `createLogger({ tag })` (see each package's `src/logger.ts`). The logger emits a timestamp, a `[LEVEL]` label, and the tag, so call sites must not prefix messages with `[INFO]`/`[DEBUG]`-style tags. Default level is `info` (DEBUG stays off unless enabled); set `JARVIS_LOG_LEVEL` to `debug`/`warn`/`error`/`silent` to change it. Under a test runner (`VITEST` set) the default is `silent`, so `npm test` prints only test output; `JARVIS_LOG_LEVEL` still overrides it when a test needs its logs. Never print tracing messages to the client REPL's stdout — the CLI routes diagnostics to stderr so stdout stays reserved for the streamed response.
- Sensitive data: user prompts and streamed response tokens are real user data — log them only through the logger's dedicated methods (`logger.sensitive` / `logger.sensitiveDebug`). Payloads are redacted by default and rendered verbatim only in development (`NODE_ENV=development`, as set by the server's `npm run dev`); never log raw prompts/response payloads in production. `JARVIS_LOG_SENSITIVE` overrides the mode.
- It is acceptable to add `README.md` files to specific subdirectories when their contents are sufficiently complex, unintuitive, or home to non-trivial business logic — such READMEs follow the same keep-current rule.
- **Read a module's `README.md` before grepping its source.** Every package has one, and the busier ones also carry a subdirectory map — `packages/server/src/README.md` is a per-file table of what each module owns and why, and it is the fastest way to answer "where does X live / who calls Y / why is it shaped this way". These are maintained alongside the code, so searching first wastes a turn and can mislead. Reach for search only to confirm something a README does not cover, or to find the one caller a file map does not name — and if a README is wrong or silent about what you just learned, fix it in the same change.
- **Before adding a limiter, quota, or any other resource control, read the rate-limiting section of `packages/server/README.md`.** It records which mechanism owns which surface and why `RateLimiter` must not be reused for quotas — a mistake that is otherwise easy to repeat, because its `admit()`/`recordSuccess()` pair reads like a general-purpose limiter.
- **Containerization (#28):** the server has a production image at the repo root. `Dockerfile` is multi-stage — `deps` (full install + `tsc` build of the compiled packages and contracts codegen; no Vite), `prod` (`npm ci --omit=dev --ignore-scripts` then `npm rebuild better-sqlite3`), `runtime` (`node:24-bookworm-slim`, non-root uid `10001`, no toolchain). `contracts` is built by invoking its steps directly rather than through `npm run build -w @lukestanbery/jarvis-contracts`, because that script chains `git diff --exit-code` drift guards that cannot run without a `.git` in the build context; CI still runs the guarded build. `.dockerignore` keeps `node_modules`, `dist`, `graphify-out/`, and `.env` out of the context. `docker-compose.yml` runs the server against a host-side LLM via `host.docker.internal` and persists state in the `jarvis-data` volume at `/home/jarvis/.jarvis`. The image is server-only — clients are separate deployments (#29). CI builds the image, boots it, and asserts `/health`, the volume paths, and the non-root uid.
- Each package is independently publishable to npm (`npm pack --dry-run` from the package to verify contents).
- Do not commit changes unless the user explicitly asks. Never stage, commit, or push without an explicit instruction to do so.

## Rule: close the corresponding GitHub issues in the PR

Every PR that delivers tracked work must close the issues it satisfies, so GitHub closes them automatically on merge instead of leaving the tracker stale.

- Put a GitHub closing keyword on its own line in the **PR description** (not just the commit subject), referencing the issue by number: `Closes #33`. Also valid: `close`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`. `owner/repo#33` works for issues in other repos.
- One closing keyword closes only the **first** issue named on its line — list further issues as separate `Closes #n` lines or a bulleted list so each is picked up.
- Before writing the line, check the issue's acceptance criteria and confirm the PR actually satisfies them; note which PR/commit delivered the work. Reference the issues that are genuinely done — do not close an issue on the assumption that it is.
- If a PR only **partially** advances an issue, do not use a closing keyword: state the remaining scope in the description (and add a task comment) and leave the issue open.
- Keep it in step with the PR template (`.github/PULL_REQUEST_TEMPLATE.md`), which asks for these lines explicitly.

## Rule: keep README files current

Whenever a change makes any `README.md` stale or outdated, update it in the same change. READMEs describe purpose, usage, scripts, and endpoints — keep them accurate, especially when adding/removing scripts, dependencies, endpoints, or package structure.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- The graph needs no manual upkeep: a post-commit hook rebuilds it automatically (AST-only, no API cost). Run `npm run graph:update` only if the graph is unexpectedly stale or you want to force a re-cluster after a large refactor.
- Check structural health with `npm run graph:health` (`graphify diagnose multigraph`). See the baseline below before treating any number as a regression — the post-commit hook rebuilds on every commit, so the counts drift naturally.

### Known graph health baseline

As extracted on 2026-10-13 (the #107 dedupe tree) the graph holds **3046 nodes, 6336 edges, 224 communities**. `npm run graph:health` reports **0** missing/dangling endpoints, **0** exact duplicate edges, and **0** same-endpoint collapses in both `--directed` and default modes. The graph is a plain `Graph`/`DiGraph`, not a `MultiDiGraph`, so collapse is structurally impossible. (The original full build reported 2 dangling / 107 duplicates / 222 directed + 247 undirected collapses; the AST rebuild cleared all of them.) Ten false-positive self-loops were then pruned from `graph.json` by hand (see below), so the current file holds **6326 edges / 3 self-loops**.

Three self-loops remain, all genuine recursion:

| Node                                                  | Cause                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/server/src/llm/tools/math.ts` `unary()`     | Recursion folding unary `+`/`-`.                                            |
| `scripts/check-dependencies.mjs` `listSourceFiles()`  | Recursion walking subdirectories.                                           |
| `packages/voice/test/lifecycle.test.ts` `sessionIn()` | Recursion replaying prior transitions to build a snapshot in a given state. |

Ten further self-loops are false positives from one graphify extractor bug: a member call whose method name matched a local function of the same name resolved to that local function. `this.method()` calls resolve correctly, so the fault is receiver-scoped, and each false edge is a call on a _different_ receiver:

| Node (false self-loop)                                   | Actual call site          |
| -------------------------------------------------------- | ------------------------- |
| `packages/portal/src/components/ui.tsx` `confirm()`      | `window.confirm(message)` |
| `packages/web/src/ChatClient.ts` `close()`               | `socket.close()`          |
| `packages/web/src/audio.ts` `stop()`                     | `source.stop()`           |
| `packages/voice/src/controller.ts` `dispose()`           | `wakeStt.dispose()`       |
| `packages/voice/src/providers/openWakeWord.ts` `start()` | `mic.start()`             |
| `packages/voice/src/providers/openWakeWord.ts` `stop()`  | `mic.stop()`              |
| `packages/voice/src/providers/webSpeech.ts` `start()`    | `recognition.start()`     |
| `packages/voice/src/providers/webSpeech.ts` `stop()`     | `recognition.stop()`      |
| `packages/voice/src/barge.ts` `start()`                  | `vad.start()`             |
| `packages/web/src/AppShell.tsx` `toggleWake()`           | `voice.toggleWake()`      |

Filed upstream as [Graphify-Labs/graphify#4082](https://github.com/Graphify-Labs/graphify/issues/4082).

The post-commit hook (`.husky/post-commit`) rebuilds **incrementally** — only the paths changed in the commit — so a docs-only commit leaves the hand-prune intact, and the ten edges reappear only once one of those source files is next edited. Expect 13 self-loops / 6336 edges again after a `--force` update or a fresh full build, and re-prune by deleting the ten `source == target` edges listed above.

The report's "isolated node" count is mostly noise. By undirected degree, 1224 of 3046 nodes have ≤1 connection: 59 are `package.json` config keys (`name`/`version`/…), 26 are interface method declarations in `packages/auth/src/store.ts`, and 86 carry no `source_file` (re-export and type aliases). Only 74 nodes are genuinely zero-degree — protocol/auth/voice index re-export aliases (`parseFrame`, `ChatMode`, `AuthError`, the `MAX_*` constants), three untyped stub files (`vite-env.d.ts` ×2, `kokoro-modules.d.ts`; `copy-voice-assets.d.mts` now declares its two functions but the extractor does not index declarations), and a handful of lone type refs (`ref_vosk_browser`). Real signal: 0 duplicate node keys across 3046 nodes. Do not restructure working code to raise the connectivity score.
