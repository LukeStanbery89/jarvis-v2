# @lukestanbery/jarvis-server

Express backend server for the J.A.R.V.I.S. AI assistant. Accepts prompt messages over
WebSocket and streams a response back to the client.

## Prerequisites

- Node.js 24+
- npm
- A running OpenAI-compatible inference server. [LM Studio](https://lmstudio.ai) is the
  default — launch it, load a model, and start its local server on port `1234`.

## Install

```sh
npm install @lukestanbery/jarvis-server
```

## Scripts

| Script                  | Description                                                |
| ----------------------- | ---------------------------------------------------------- |
| `npm run build`         | Compile TypeScript to `dist/`                              |
| `npm run typecheck`     | Type-check src and tests (no emit)                         |
| `npm run dev`           | Run the server with watch mode                             |
| `npm start`             | Run the compiled server                                    |
| `npm test`              | Run the test suite (Vitest)                                |
| `npm run tts:harness`   | Local TTS harness: synthesize text and play it aloud (#83) |
| `npm run probe:sandbox` | Probe the Docker assumptions the sandbox (#141) rests on   |

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

### Docker

The repository root ships a production image and a compose file:

```sh
docker compose up -d --build
curl http://localhost:54321/health        # -> {"ok":true}
```

The image builds only the five packages the server loads at runtime —
`protocol`, `logger`, `auth`, `contracts`, and `server` — and ships no
compilers or dev dependencies. It runs as non-root uid `10001` with a
`HEALTHCHECK` against `/health`. Clients (#29) are separate deployments.

Four things are worth knowing:

- **`LLM_BASE_URL` must not stay `localhost`.** Inside a container `localhost`
  is the container, not your machine, so the default `http://localhost:1234/v1`
  cannot reach a host-side LM Studio. Compose sets
  `http://host.docker.internal:1234/v1` for you; override it for any other
  OpenAI-compatible endpoint.
- **State is a named volume.** `jarvis-data` mounts at
  `/home/jarvis/.jarvis`, and because the image sets `HOME` the defaults for
  `JARVIS_DB_PATH` and `JARVIS_CHECKPOINT_PATH` resolve inside it. Both SQLite
  files survive `docker compose down && up`.
- **Bootstrap is off by default.** Set `JARVIS_BOOTSTRAP_TOKEN` (in a `.env`
  beside the compose file, or as an environment variable at `up` time) before
  calling `POST /api/bootstrap`; until then it returns `409`.
- **No SPAs are baked in.** `/` answers `Hello World` (no app build), `/admin` 404s, and `/web` 301s to `/chat`.
  To serve them, build them on the host and mount the directories — see below.

#### Serving the SPAs from the image

Build the SPA bundles on the host (they are not in the image), then mount them
and point the server at the mount points:

```sh
npm run build -w @lukestanbery/jarvis-portal -w @lukestanbery/jarvis-web
```

```yaml
volumes:
    - ./packages/portal/dist:/srv/portal:ro
    - ./packages/web/dist:/srv/web:ro
environment:
    JARVIS_PORTAL_DIR: /srv/portal
    JARVIS_WEB_DIR: /srv/web
```

A directory is mounted only when it contains `index.html`: a wrong path for the
app degrades to `Hello World` at `/` and a warning, and one for the portal leaves
`/admin` an honest 404 — each rather than failing to boot.

#### Probing the sandbox assumptions (#141)

`npm run probe:sandbox` runs three short-lived labelled containers and reports
whether the things the coding sandbox will depend on actually hold **on this
machine**: a bind mount written inside a container is visible at the host path
the server reads (and, as an observation, what the engine does with a mount
source that exists only inside a container — the trap
`JARVIS_SANDBOX_WORKSPACE_HOST_ROOT` exists to avoid); a sibling container can
reach the host LLM, reporting which spelling worked — native
`host.docker.internal` or `--add-host host-gateway`; and a container left by a
crashed run is discoverable by label, readable (adopt), removable (prune), and
absent afterwards, with the server's own container excluded from the managed
set.

It uses the `docker` CLI rather than the library the runner will use, because
it probes the environment and not our code. Needs a running daemon (pulls
`alpine:3` if missing) and is not part of `npm test` or CI; exit `0` means
every gating assertion held, `1` one failed, `2` the daemon was unusable.

#### The coding sandbox (#141)

Coding jobs are **off by default** and live in an overlay, because they need two
things the base deployment deliberately does not grant: the Docker socket
(root-equivalent — an owner-only v1 decision, with #138 owning the real
capability boundary) and a host-visible workspace directory (a sibling
container's bind source is resolved on the _host_, not inside the server).

```sh
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d
```

The job image is built from `Dockerfile.job` at the repository root (agent +
git + gh + toolchain; the server image stays toolchain-free):

```sh
docker build -f Dockerfile.job -t jarvis-job:latest .
```

The same tree has two paths, and they differ exactly when the server runs in a
container: the server reads `~/.jarvis/jobs`, while the daemon resolves the
bind source on the host. The overlay sets both from one mount, and
`JARVIS_SANDBOX_WORKSPACE_HOST_ROOT` is the host side.

The container posture is fixed in `src/sandbox/docker.ts`: the workspace is the
only mount (read-write), the root filesystem is read-only with tmpfs for
scratch, capabilities are dropped, `no-new-privileges` is set, and CPU /
memory / process / wall-clock ceilings apply. A job cannot reach the host's
home directory, the socket, or the provider key (see the broker below).

A job clones its allowlisted repository into `~/.jarvis/jobs/<id>/repo` on a
`jarvis/<slug>-<id>` branch, runs the agent against that directory, records
what it left behind (`diff --stat`, the commits it added, a bounded log tail)
and announces one ending. A successful workspace is kept for the pull-request
step; a failed one is removed. If JARVIS dies mid-job, the boot reaper either
**prunes** the container (the default: it is stopped, its tail recorded and the
row settled `failed` with the reason) or **resumes** it (adopt the still-running
container and keep watching) — a choice stored per job and made when it is
created.

The host-side git calls are a trust boundary too: after the agent has run,
`.git` is hostile input to _our_ git. `collect` and `commit` rewrite
`.git/config` to the minimal clone shape (core plus origin, with the URL
validated to one line) before any host git touches the tree, so a planted
`pre-commit` hook, `core.hooksPath`, `filter.*.clean`, `diff.external` or
`gpg.program` cannot execute on the host; every host call also passes
`-c core.hooksPath=/dev/null`, `-c core.fsmonitor=false` and
`-c commit.gpgsign=false`, and diffs add `--no-ext-diff --no-textconv`. The
safety-net commit is authored `JARVIS <jarvis@localhost>`, so a CI host with no
git identity still commits.

Each job's **full output** is written live to
`~/.jarvis/logs/coding/<id>.log` (`0600`, 10 MiB cap with one truncation
marker), because the container is removed at settle and the row keeps only the
last 16 KB. Retention runs at boot: settled workspaces older than
`JARVIS_SANDBOX_WORKSPACE_RETENTION_DAYS` (14) and log files older than
`JARVIS_SANDBOX_LOG_RETENTION_DAYS` (30) are removed, and a directory with no
row is removed too. Every settle prunes the owner's settled rows to the newest
`JARVIS_SANDBOX_KEEP_JOB_ROWS` (100). A successful workspace is kept until its
branch is pushed (or, without an App, for the retention window): until then it
is the only copy of the work. While a job runs,
`GET /api/coding-jobs/{id}/logs` follows its output as newline-delimited JSON
(owner-scoped: a foreign id is a 404); after it settles the same route serves
the file, so a page uses one URL for both halves.

With a GitHub App configured — `JARVIS_GITHUB_APP_ID`, its private key
(`JARVIS_GITHUB_APP_PRIVATE_KEY` with `\n` escapes, or
`JARVIS_GITHUB_APP_PRIVATE_KEY_PATH`), and
`JARVIS_GITHUB_INSTALLATION_ID` — a successful job that changed files is
pushed and gets a pull request on the repository's default branch. The push
carries a short-lived installation token in the child's environment (never
`argv`, never the container), the ending's notification names the pull request,
and the workspace is removed once the branch is pushed: the remote is then the
copy. Every publish — a new pull request or a follow-up push — also asks the
human to review: `JARVIS_GITHUB_REVIEWER`, defaulting to the repository's owner
(the person on a personal repo; an org-owned repository needs it set). The
request is best-effort: a PR that could not ask for a reviewer is still a PR.
Without an App the branch stays local, the notification says why it was not
pushed, and the workspace lives until retention.

A **follow-up** continues an open pull request instead of starting a new branch:
`startCodingJob` takes `pullRequest` (its number or its URL), the job checks out
that PR's head branch from the remote, and its prompt carries the PR's
description plus its review comments and conversation (newest last, bounded).
The run pushes back to the same branch, so the review updates in place and no
second PR opens; the ending says "Updated pull request". Only a PR in the
repository itself can be continued — a fork's branch is not on this origin, and
a closed or merged PR has nothing left to do. The App needs **Pull requests:
read & write**; reading the conversation (as opposed to inline review notes)
also needs **Issues: read**, and without it the job still runs with the inline
notes and its prompt says the conversation could not be read.

The same App backs four **tracker tools** — `getGitHubIssue`,
`listGitHubIssues`, `createGitHubIssue`, `commentOnGitHub` — registered whenever
the App is configured and `JARVIS_GITHUB_REPOS` (default:
`JARVIS_SANDBOX_REPOS`) is non-empty. They are owner-only like the job tool,
every call names an allowlisted repository (or falls back to the single one),
and a failure quotes GitHub's message with the permission hint a 403 needs: the
App must have **Issues: read & write** to read or write them. Creating a
repository is deliberately not exposed. `startCodingJob` also takes `issue`: it
reads the issue on the host and prepends its title, state, labels, URL and
description to the task, so "implement issue #N" is one call instead of a body
the relay model would have to paste.

The default coding model is **OpenCode's `big-pickle`** at
`https://opencode.ai/inference/openai/v1`, authenticated with
`JARVIS_SANDBOX_API_KEY` (an OpenCode workspace key). Big Pickle is a free
stealth model on the Console endpoint, and the job's own `opencode run` is the
client the free tier admits. A Go-plan model works too — point
`JARVIS_SANDBOX_LLM_BASE_URL` at `https://opencode.ai/inference/go/openai/v1`
and `JARVIS_SANDBOX_MODEL` at the Go id. A local model works as well: point the
URL at the host and the model at the local id, and leave the key empty; no key
is required for a local endpoint, and a remote one without a key is refused
before anything is cloned.

**The key never enters the container.** `src/sandbox/proxy.ts` is a broker the
server runs: it keeps `JARVIS_SANDBOX_API_KEY`, and each job is handed
`jv1.<jobId>.<HMAC(secret, jobId)>` as its provider key plus the broker's URL.
Every request re-checks the ledger, so a settled, cancelled or pruned job is
refused immediately even if its token leaked; only `POST /v1/chat/completions`
and `GET /v1/models`, only the configured model, and only within a per-job
request cap are forwarded. The HMAC secret persists in
`~/.jarvis/sandbox-proxy.key` (private, `0600`) unless
`JARVIS_SANDBOX_PROXY_SECRET` supplies one, so a job that `resume` adopts after
a restart keeps working. In dev the broker binds loopback — a container's
request arrives there through `host.docker.internal`, and the LAN cannot reach
it; the compose overlay instead gives the broker an unpublished port on the
`jarvis-sandbox` network, which the job containers join.

Ask for one in chat: the `startCodingJob` tool is registered whenever the
sandbox is on, accepts only an allowlisted repository, and is **owner-only** —
a sandbox with a clone and network access is the most capable thing JARVIS
runs, so it is not a `user`-role capability yet. It returns a job id
immediately; the ending arrives as a notification, so the assistant does not
hold the reply open for it. A follow-up is the same tool with `pullRequest`
set — it works on that PR's branch and pushes back to it.

`npm run probe:coding-job` is the manual end-to-end check: a throwaway local
repository, the real image, a real agent and the configured model. It prints
the settled row, the diff summary and the workspace's git log, and exits
non-zero unless the job settled `ok`.

| Variable                                  | Default                                   | Meaning                                                                                      |
| ----------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `JARVIS_SANDBOX`                          | _(unset)_                                 | `docker` enables the surface; anything else leaves it absent                                 |
| `JARVIS_SANDBOX_IMAGE`                    | `jarvis-job:latest`                       | the job image, built by this repository                                                      |
| `JARVIS_SANDBOX_DOCKER_SOCKET`            | `/var/run/docker.sock`                    | the daemon's socket                                                                          |
| `JARVIS_SANDBOX_WORKSPACE_ROOT`           | `~/.jarvis/jobs`                          | workspaces **as the server sees them**                                                       |
| `JARVIS_SANDBOX_WORKSPACE_HOST_ROOT`      | the same                                  | workspaces **as the daemon sees them** — set this in a container deployment                  |
| `JARVIS_SANDBOX_MAX_JOBS`                 | `1`                                       | jobs allowed to run at once                                                                  |
| `JARVIS_SANDBOX_CPUS`                     | `2`                                       | cores per job                                                                                |
| `JARVIS_SANDBOX_MEMORY_MB`                | `4096`                                    | memory ceiling per job                                                                       |
| `JARVIS_SANDBOX_PIDS`                     | `512`                                     | process ceiling per job                                                                      |
| `JARVIS_SANDBOX_WALL_CLOCK_MINUTES`       | `45`                                      | the supervisor stops a job that overruns                                                     |
| `JARVIS_SANDBOX_REPOS`                    | _(empty)_                                 | `owner/name` allowlist; empty clones nothing                                                 |
| `JARVIS_SANDBOX_MODEL`                    | `big-pickle`                              | the model id handed to the agent                                                             |
| `JARVIS_SANDBOX_LLM_BASE_URL`             | `https://opencode.ai/inference/openai/v1` | the OpenAI-compatible endpoint a job container talks to                                      |
| `JARVIS_SANDBOX_API_KEY`                  | _(empty)_                                 | the provider key; required for a remote endpoint, never logged                               |
| `JARVIS_SANDBOX_EXTRA_HOSTS`              | `host.docker.internal:host-gateway`       | extra `/etc/hosts` entries; `none` disables                                                  |
| `JARVIS_SANDBOX_PROXY_BIND`               | `127.0.0.1`                               | the broker's interface; compose binds `0.0.0.0` on its private network                       |
| `JARVIS_SANDBOX_PROXY_PORT`               | `54322`                                   | the broker's port                                                                            |
| `JARVIS_SANDBOX_PROXY_URL`                | `http://host.docker.internal:54322/v1`    | the broker URL a job is handed (compose: `http://jarvis:54322/v1`)                           |
| `JARVIS_SANDBOX_PROXY_SECRET`             | _(private file)_                          | the HMAC secret; `~/.jarvis/sandbox-proxy.key` when unset                                    |
| `JARVIS_SANDBOX_PROXY_MAX_REQUESTS`       | `500`                                     | requests one job may make through the broker before `429`                                    |
| `JARVIS_SANDBOX_NETWORK`                  | _(engine default bridge)_                 | the Docker network job containers join (compose: `jarvis-sandbox`)                           |
| `JARVIS_SANDBOX_LOG_ROOT`                 | `~/.jarvis/logs/coding`                   | where each job's full output is written (`0600` files)                                       |
| `JARVIS_SANDBOX_LOG_MAX_MB`               | `10`                                      | per-job log cap; one marker line is written past it                                          |
| `JARVIS_SANDBOX_WORKSPACE_RETENTION_DAYS` | `14`                                      | settled workspaces older than this are swept at boot                                         |
| `JARVIS_SANDBOX_LOG_RETENTION_DAYS`       | `30`                                      | log files older than this are swept at boot                                                  |
| `JARVIS_SANDBOX_KEEP_JOB_ROWS`            | `100`                                     | settled rows kept per user; older ones are pruned at settle                                  |
| `JARVIS_GITHUB_APP_ID`                    | _(unset)_                                 | the GitHub App id; publishing is off without it, the key and an installation                 |
| `JARVIS_GITHUB_APP_PRIVATE_KEY`           | _(unset)_                                 | the App PEM inline (`\n` escapes allowed)                                                    |
| `JARVIS_GITHUB_APP_PRIVATE_KEY_PATH`      | _(unset)_                                 | or a file holding the PEM; used only when the inline value is absent                         |
| `JARVIS_GITHUB_INSTALLATION_ID`           | _(unset)_                                 | the installation that serves the allowlisted repositories                                    |
| `JARVIS_GITHUB_API_BASE_URL`              | `https://api.github.com`                  | REST host, for a GitHub Enterprise install                                                   |
| `JARVIS_GITHUB_REPOS`                     | `JARVIS_SANDBOX_REPOS`                    | comma-separated `owner/name` allowlist for the tracker tools; empty leaves them unregistered |
| `JARVIS_GITHUB_REVIEWER`                  | repository owner                          | login asked to review a published PR (create or follow-up); best-effort                      |

#### Container environment reference

Everything in the configuration table below applies unchanged inside the
container, with two differences:

| Variable                                   | In the container                                          |
| ------------------------------------------ | --------------------------------------------------------- |
| `LLM_BASE_URL`                             | Must point off-container (`host.docker.internal:1234/v1`) |
| `JARVIS_DB_PATH`, `JARVIS_CHECKPOINT_PATH` | Default to `/home/jarvis/.jarvis`, on the volume          |

### Configuration

The model is reached via LangChain (`@langchain/openai`) pointed at an
OpenAI-compatible endpoint. Everything is configurable through environment
variables; a variable that is set but does not parse (a typo, trailing
whitespace) falls back to its documented default with a startup warning
naming the variable — a typo can never break the server start, and it cannot
fail silently either:

| Variable                                 | Default                                                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                   | `54321`                                                                         | HTTP listener port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `JARVIS_NOTIFY`                          | (unset)                                                                         | `off` removes the notification surface entirely (#139) — no `/api/notifications` routes and no delivery wiring                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_NOTIFY_DELIVERIES_PER_MIN`       | `20`                                                                            | Pushes allowed per user per minute; over budget a notification is still recorded and listed, just not pushed                                                                                                                                                                                                                                                                                                                                                                                                    |
| `JARVIS_NOTIFY_MAX_PER_USER`             | `200`                                                                           | Notifications kept per user; settled rows are evicted first, then the oldest survivor, so the ceiling holds for the table                                                                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_SCHEDULER`                       | (unset)                                                                         | `off` removes the scheduler entirely (#90) — no tick loop, no `jobs` tool (phase 3); `JARVIS_NOTIFY=off` removes it too, since a run's outcome is announced through the notification service                                                                                                                                                                                                                                                                                                                    |
| `JARVIS_JOB_TICK_MS`                     | `5000`                                                                          | How often the scheduler scans for due jobs; coarse on purpose, so a job can start up to one tick late and a restart has nothing to rebuild                                                                                                                                                                                                                                                                                                                                                                      |
| `JARVIS_JOB_MAX_PER_USER`                | `50`                                                                            | Jobs kept per user; settled rows are evicted first, then the oldest pending one, so the ceiling holds for the table                                                                                                                                                                                                                                                                                                                                                                                             |
| `JARVIS_JOB_MAX_LATENESS_MS`             | `3600000`                                                                       | How late a job may be and still run; past it the job is recorded (and announced) as `missed` rather than attempted, because a reminder that fires six hours after the fact is not a reminder                                                                                                                                                                                                                                                                                                                    |
| `JARVIS_JOB_MAX_PER_TICK`                | `1`                                                                             | Jobs one tick takes on; above 1 the runs really do go concurrently, against one model — a home server has one                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LLM_BASE_URL`                           | `http://localhost:1234/v1`                                                      | OpenAI-compatible base URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LLM_MODEL`                              | `qwen/qwen3-4b-2507`                                                            | Model served by the server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LLM_TEMPERATURE`                        | `0.15`                                                                          | Sampling temperature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `LLM_SYSTEM_PROMPT`                      | `You are J.A.R.V.I.S., a helpful, personal AI assistant. ...` (concise persona) | System message priming every conversation thread; the server always appends seven fixed hygiene paragraphs (one tool call at a time with well-formed arguments; exactly one `getCurrentTime` call per time/date/weekday ask, passing the question verbatim, never reusing an earlier answer; the image-analysis rule; the home-assistant rule; the tools-over-memory rule for research, #8; notification restraint, #139; and scheduling discipline, #90) plus capability notes — see the Chat protocol section |
| `JARVIS_AGENT_MAX_TURNS`                 | `10`                                                                            | Max agent loop steps per turn (tools + model calls)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `JARVIS_CHECKPOINT_PATH`                 | `~/.jarvis/checkpoints.sqlite`                                                  | SQLite checkpoint file for conversation persistence                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `JARVIS_DB_PATH`                         | `~/.jarvis/jarvis.sqlite`                                                       | App database: users, devices, sessions, prefs                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `JARVIS_TURN_TIMEOUT_MS`                 | `120000`                                                                        | Hard cap for one agent turn before it is aborted                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `LLM_VL_MODEL`                           | `qwen3.6-35b-a3b-splash`                                                        | Vision-language model the `analyzeImage` tool calls (must accept `image_url` parts)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `LLM_VL_MAX_TOKENS`                      | `1024`                                                                          | Output-token cap for one image analysis                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `LLM_VL_TIMEOUT_MS`                      | `60000`                                                                         | Wall-clock cap for one image analysis (abort bound)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `JARVIS_ATTACHMENT_TTL_MINUTES`          | `60`                                                                            | How long an uploaded image stays analyzable                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `JARVIS_ATTACHMENT_MAX_BYTES`            | `4194304` (4 MiB)                                                               | Decoded-byte cap per attachment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `JARVIS_ATTACHMENT_MAX_TOTAL_BYTES`      | `209715200` (200 MiB)                                                           | Per-user total across live attachments                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `JARVIS_ATTACHMENT_VL_CALLS_PER_MIN`     | `10`                                                                            | Vision-analysis calls per user per minute                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_ATTACHMENT_MAX_INFLIGHT`         | `4`                                                                             | Concurrent uploads server-wide                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_ATTACHMENT_DIR`                  | `<tmpdir>/jarvis-attachments`                                                   | Attachment root (mode-verified private; emptied at boot)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `TAVILY_API_KEY`                         | unset                                                                           | Tavily search key — enables the `general`/`news`/`finance` verticals of `webSearch`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SERPER_API_KEY`                         | unset                                                                           | Serper search key — enables the Serper-only verticals (`images`, `videos`, `places`, `reviews`, `patents`, `shopping`, `scholar`)                                                                                                                                                                                                                                                                                                                                                                               |
| `JARVIS_SEARCH_TIMEOUT_MS`               | `15000`                                                                         | Wall-clock cap for one provider search call                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `JARVIS_SEARCH_MAX_RESULTS`              | `5`                                                                             | Results handed to the model per search                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `JARVIS_SEARCH_CALLS_PER_MIN`            | `20`                                                                            | Per-user search-call quota                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `OPENWEATHER_API_KEY`                    | unset                                                                           | OpenWeather key — enables the `getWeather` tool (current + 5-day forecast)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `JARVIS_WEATHER_UNITS`                   | `imperial`                                                                      | Unit system reported to the model (`metric` supported)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `JARVIS_WEATHER_TIMEOUT_MS`              | `10000`                                                                         | Wall-clock cap for one provider weather call                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `JARVIS_WEATHER_CALLS_PER_MIN`           | `10`                                                                            | Per-user weather-call quota                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `HOME_ASSISTANT_URL`                     | unset                                                                           | Home Assistant base URL (no trailing slash needed) — enables the `homeAssistant` tool                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `HOME_ASSISTANT_ACCESS_TOKEN`            | unset                                                                           | Long-lived HA token; required alongside the URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `JARVIS_HA_READ_DOMAINS`                 | `light,switch,climate,fan,sensor,binary_sensor,cover,media_player,lock`         | Domains whose entities the model may read                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_HA_CONTROL_DOMAINS`              | `light,switch,climate,fan`                                                      | Domains whose entities the model may write (a strict subset of reads)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `JARVIS_HA_CALLS_PER_MIN`                | `10`                                                                            | Per-user Home Assistant call quota                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `JARVIS_HA_TIMEOUT_MS`                   | `10000`                                                                         | Wall-clock cap for one HA call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_HA_CACHE_TTL_MS`                 | `15000`                                                                         | How long an entity snapshot is reused; `0` disables the cache                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `JARVIS_HA_LIST_LIMIT`                   | `40`                                                                            | Max entities listed by one `list`, `lights` or `switches` call                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_HA_LIGHT_TOKENS`                 | `light,lamp,bulb,strip,ceiling,sconce,luminaire,fixture`                        | Name fragments that make a light a light to `action: "lights"`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_WIKIPEDIA`                       | `on`                                                                            | `off` removes the `wikipedia` tool; it is the one optional tool enabled without a credential                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `JARVIS_WIKIPEDIA_LANG`                  | `en`                                                                            | Wiki language subdomain (validated as a host label)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `JARVIS_WIKIPEDIA_TIMEOUT_MS`            | `10000`                                                                         | Wall-clock cap for one Wikipedia API call                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_WIKIPEDIA_MAX_SENTENCES`         | `5`                                                                             | Leading sentences a summary extract asks for (API caps at 10)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `JARVIS_WIKIPEDIA_MAX_FULL_CHARS`        | `6000`                                                                          | Character budget for `detail: "full"`; the result states the omission                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `JARVIS_WIKIPEDIA_MAX_CANDIDATES`        | `5`                                                                             | Candidate titles returned when a query is ambiguous                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `JARVIS_WIKIPEDIA_CALLS_PER_MIN`         | `20`                                                                            | Per-user Wikipedia call quota                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `JARVIS_WIKIPEDIA_GUEST_SESSION_PER_MIN` | `3`                                                                             | Per-guest-session quota (both this and the per-address budget must admit)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_WIKIPEDIA_GUEST_IP_PER_MIN`      | `10`                                                                            | Aggregate per-guest-client-address quota                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `JARVIS_WIKIPEDIA_USER_AGENT`            | `jarvis-v2/0.1 (+https://github.com/LukeStanbery89/jarvis-v2)`                  | Descriptive `User-Agent` (Wikimedia policy; empty is answered 403)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `JARVIS_BOOTSTRAP_TOKEN`                 | unset                                                                           | One-time setup credential; see the `@lukestanbery/jarvis-auth` README                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `JARVIS_HOST`                            | `0.0.0.0`                                                                       | Bind address (all interfaces = LAN posture)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `JARVIS_TLS_CERT`                        | unset                                                                           | PEM certificate path — enables HTTPS serving                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `JARVIS_TLS_KEY`                         | unset                                                                           | Matching PEM private key (required with `JARVIS_TLS_CERT`)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `JARVIS_HTTP_REDIRECT_PORT`              | `PORT + 1`                                                                      | Cleartext port that upgrades to HTTPS (TLS mode)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `JARVIS_PORTAL_DIR`                      | `packages/portal/dist`                                                          | Built portal SPA root served at `/`; empty string disables it                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `JARVIS_WEB_DIR`                         | `packages/web/dist`                                                             | Built web app root served at `/`; empty string disables it                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `JARVIS_RATE_WINDOW_MS`                  | `900000` (15 min)                                                               | Attempt-accumulation window for login/bootstrap                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `JARVIS_RATE_MAX_FAILURES`               | `10`                                                                            | Attempts per `(ip, username)` before a lockout                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_RATE_MAX_IP_FAILURES`            | `100`                                                                           | Aggregate attempts per IP per window — the cap for `login:<ip>` and `bootstrap:<ip>` keys                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_RATE_LOCKOUT_MS`                 | `60000`                                                                         | Base lockout; doubles per repeat (backoff, ×32 cap)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `JARVIS_CORS_ORIGINS`                    | unset (deny all cross-origin)                                                   | Comma-separated exact origins allowed to call `/api` cross-origin; no wildcard                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_TRUST_PROXY_CIDRS`               | unset (trust none)                                                              | IPs/subnets whose `X-Forwarded-For` is believed for `req.ip`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `JARVIS_SESSION_TTL_MS`                  | `2592000000` (30 days)                                                          | Absolute lifetime of a cookie session (no sliding)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `JARVIS_API_CONTRACT`                    | unset                                                                           | Set `verify` to also validate REST response bodies against the OpenAPI contract (request shapes are always validated)                                                                                                                                                                                                                                                                                                                                                                                           |
| `JARVIS_LOG_LEVEL`                       | `info` (`silent` under tests)                                                   | Log verbosity: `silent` \| `debug` \| `info` \| `warn` \| `error`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `JARVIS_LOG_SENSITIVE`                   | `auto`                                                                          | Force sensitive payload logging: `full` \| `redacted`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

```sh
LLM_MODEL=some-other-model npm run dev
```

#### `.env` file

Copy the example and edit it instead of prefixing every command:

```sh
cp .env.example .env
```

`packages/server/.env` is loaded automatically at startup (both `npm run dev`
and `npm start`) by `import "dotenv/config"` in `src/index.ts`. Rules:

- It is **gitignored — never commit it**; it can hold secrets such as
  `JARVIS_BOOTSTRAP_TOKEN`. `.env.example` holds placeholders only, so it can
  be shared.
- **Real environment variables always win** over `.env` (dotenv's default), so
  a value set for one run via `VAR=… npm start` overrides the file, and CI /
  systemd environments are unaffected by it.
- It is read once at process start; editing it does not hot-reload under
  `tsx watch`.

First-run setup (once the server is up and `JARVIS_BOOTSTRAP_TOKEN` is set):

```sh
curl -X POST http://localhost:54321/api/bootstrap \
  -H 'x-bootstrap-token: <JARVIS_BOOTSTRAP_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"username":"luke","password":"<choose-a-strong-password>"}'
```

The response's `device.token` is your admin credential. Passwords must be at
least 8 characters, and the bootstrap token is read **only** from the
`x-bootstrap-token` header (never the JSON body). The bootstrap token is
single-use: a `BootstrapGate` in the router consumes it after the first
successful bootstrap (the config object is left untouched), so rerunning with
the same env value cannot mint a second owner — restart the process with a new
token if you truly need to re-bootstrap. Later, log in again
from any client with `POST /api/auth/login` to receive a fresh token, then use
it as `Authorization: Bearer <token>` (for the `/api` routes) or as the
`{ "type": "auth", "token" }` first frame on `/ws`. Re-login on the same
device name rotates the token (the old one stops working); use distinct
`deviceName`s for distinct clients. A failed login is indistinguishable from an
unknown username (same error, uniform response time), so account existence
can't be probed. Both login and bootstrap are throttled — see
[Rate limiting](#rate-limiting) for the keys, budgets, and lockout behavior.

### REST contract validation

The server enforces the OpenAPI contract at runtime: `express-openapi-validator`
runs ahead of `/api` (and `/health`) with the spec from
`@lukestanbery/jarvis-contracts` (bundled artifact when built, else the source
YAML — if neither resolves, the server logs a warning and keeps serving
unvalidated rather than refusing requests). Request shapes are always
validated — a body that violates the spec is rejected with `400 { "error": … }`
before any route logic. Response shapes are
checked only with `JARVIS_API_CONTRACT=verify` (set automatically by
`npm run dev` and by the `test/contract.test.ts` suite): a server response that
drifts from the spec fails loudly (logged 500) instead of silently mismatching
the documented contract. Security is deliberately **not** validated by the
middleware (`validateSecurity: false`) — auth is OR-composed (bearer device
token or session cookie) and stays owned by `src/http/middleware.ts`; shape
validation is purely additive to the hand-rolled checks in `authRoutes.ts`.

### Transport security

By default the server is plain HTTP (the LAN posture) and binds
`0.0.0.0` (`JARVIS_HOST` to narrow). When the server will face anything less
trusted than a known LAN, enable TLS in-node with `JARVIS_TLS_CERT` +
`JARVIS_TLS_KEY` (PEM files). TLS mode keeps serving on `PORT` as HTTPS and
starts a cleartext listener on `JARVIS_HTTP_REDIRECT_PORT` (default
`PORT + 1`) that 302-upgrades every request to the HTTPS origin. The WebSocket
endpoint inherits whichever transport the HTTP server uses, so `/ws` is
`wss://` under TLS. Local state under `~/.jarvis` is tightened on startup: the
directory becomes `0700` and each SQLite database `0600`, so account hashes
and conversation checkpoints aren't world-readable on a shared machine.

### Cross-origin and reverse proxy

Most deployments never need this section. If the browser loads the SPAs **from this
server** (the default: `/` and `/admin`) or through the Vite dev server's `/api` + `/ws`
proxy, every request is same-origin and the settings below do nothing. They matter
only when a SPA is served from a _different_ origin than the API (issue #63).

#### Allowing a cross-origin browser client

`JARVIS_CORS_ORIGINS` is a comma-separated list of **exact** origins. Unset or empty
**denies all cross-origin requests** — no `Access-Control-Allow-*` header is emitted,
so the browser blocks them and same-origin clients are untouched. Origins are matched
case-insensitively with a trailing `/` ignored, so `https://Desk.example.com/` and
`https://desk.example.com` are the same entry.

```sh
JARVIS_CORS_ORIGINS=https://desk.example.com,http://laptop.local:5173
```

There is deliberately **no wildcard**. The API is credentialed (bearer device token
_and_ session cookie), browsers reject `Access-Control-Allow-Origin: *` on credentialed
requests anyway, and honoring one would hand a credentialed API to any site the user
visits. A literal `*` in the list is dropped with a startup warning. An origin that is
not on the list gets no CORS header rather than a 403, so a refused request does not
confirm that the allowlist exists.

Preflight (`OPTIONS`) is answered with `204` **before** the OpenAPI contract validator,
which matters: the validator rejects `OPTIONS` against paths that declare only
`POST`/`GET`, so a preflight that reached it would fail instead of unlocking the real
request.

The `/ws` upgrade is unaffected — browsers do not gate WebSockets on `Origin`, and the
socket authenticates with its `auth` frame instead.

#### Cookie auth does not work cross-origin

This is a deliberate decision, not an omission. `setSessionCookie` emits
`SameSite=Strict`, which browsers never send on cross-site requests. The alternative,
`SameSite=None`, is **itself rejected by browsers without `Secure`** — and the default
posture is plain HTTP on a LAN, so enabling it would silently break cookie auth
everywhere rather than only cross-origin.

**Cross-origin browser clients must therefore authenticate with a device token**
(`Authorization: Bearer …`), which travels in a header and is unaffected by
SameSite. That is already how `packages/web` works (bearer token in `localStorage`, no
cookies, no CSRF). `packages/portal` authenticates with the cookie session
(`credentials: "same-origin"`) and therefore remains **same-origin only**; moving it
cross-origin would mean switching it to device tokens, not relaxing the cookie.

#### Behind a reverse proxy

`req.ip` is the socket address unless a proxy is trusted, so with a reverse proxy in
front every client shares one address — which collapses the credential throttle's
per-`(ip, username)` and per-`ip` keys into a single bucket (see
[Rate limiting](#rate-limiting)).

List the proxy's addresses to fix that:

```sh
JARVIS_TRUST_PROXY_CIDRS=172.16.0.0/12,10.0.0.5
```

Prefer a CIDR allowlist over a hop count or an unbounded trust: `X-Forwarded-For` is
client-controlled, so trusting it from anyone is a spoofing vector that would let a
caller forge a fresh rate-limit identity per request. Entries that fail to parse never
match, so a typo fails closed (trusting nothing) rather than open. Set this to the
Docker network's subnet when the proxy is a container.

### Logging

Log lines look like
`2026-09-20 12:00:00 [INFO] server — message`, colored by level. Reach the
level filter with `JARVIS_LOG_LEVEL` (default `info`).

User prompts and streamed response tokens are treated as **sensitive
payloads** and are redacted by default (the data is replaced by `[REDACTED]`,
token tracing suppressed). Payloads are logged verbatim only in development:
`npm run dev` sets `NODE_ENV=development`. Production deployments (any other
`NODE_ENV`, including unset) stay redacted even if `JARVIS_LOG_LEVEL=debug` is
forced. Override either way with `JARVIS_LOG_SENSITIVE=full|redacted`. The
option is provided by `@lukestanbery/jarvis-logger` (`sensitive` / `sensitiveDebug`).

Each chat turn is logged at two levels: every token as it streams
(`sensitiveDebug("LLM token", …)`), and the assembled answer once the stream
ends (`sensitive("Agent response", { text, toolCalls })`) — one line per turn,
which is what you want when reading a transcript in development.

### Empty model responses

A turn that ends with **no prose at all** (whitespace-only chunks included)
answers `{"error": "the model returned an empty response"}` + `done`, and logs
a warning naming the tool-call count. This is a model failure being reported,
not a client bug: reasoning-tuned models (the Qwen3 family, for instance) can
spend their entire output budget in the reasoning channel and return an
`AIMessage` whose `content` is empty, which the tracker correctly turns into
zero `token` events. Without the guard the client renders a permanently blank
bubble with no explanation. Note that LM Studio's OpenAI-compatible endpoint
ignores both `reasoning_budget: 0` and
`chat_template_kwargs: { enable_thinking: false }`, so this cannot be switched
off per request — the model itself has to be loaded with thinking disabled, or
answered by a non-reasoning model.

## Rate limiting

Every throttle the server applies lives in this section — this is the single source of
truth. Four mechanisms exist, because they answer four different questions and
must not be interchanged.

### Credential throttle — `src/http/rateLimit.ts`

Guards the expensive password-verification path against guessing.

There is exactly **one** `RateLimiter` instance, built from `appConfig.loginRateLimit`
and shared by every credential endpoint. Endpoints stay isolated by **key namespace**
(`login:` vs `bootstrap:`), not by separate limiters or configs.

| Endpoint                                    | Key                     | Budget                                                                           |
| ------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `POST /api/auth/login`, `POST /api/session` | `login:<ip>:<username>` | `JARVIS_RATE_MAX_FAILURES` (10) per window                                       |
| `POST /api/auth/login`, `POST /api/session` | `login:<ip>`            | `JARVIS_RATE_MAX_IP_FAILURES` (100) per window — aggregate across usernames      |
| `POST /api/bootstrap`                       | `bootstrap:<ip>`        | `JARVIS_RATE_MAX_IP_FAILURES` (100) per window — bootstrap is keyed purely by IP |

Login admits **both** keys on every attempt
(`limiter.admit(userKey, "username") ?? limiter.admit(ipKey, "ip")`), so a request
must clear the per-username budget _and_ the per-IP aggregate budget; each kind
checks its own threshold (`admit`'s `kind` parameter picks `maxFailures` vs
`maxIpFailures` — the limiter never infers it from the key's text).

Behavior:

- **Fixed window.** Attempts accumulate over `JARVIS_RATE_WINDOW_MS` (15 min) and the
  counter resets when the window lapses, so a client that stops misbehaving recovers on
  its own.
- **Every attempt counts, right or wrong.** `admit()` increments _before_ the expensive
  scrypt verify runs. Node's single thread serializes the increment, so a burst of
  concurrent guesses cannot all observe a pre-limit count while their verifications are
  still in flight.
- **Success clears the key.** `recordSuccess()` deletes the entry, so a legitimate user
  is never punished for repeated correct logins.
- **Lockout backs off.** Crossing the budget locks the key for
  `JARVIS_RATE_LOCKOUT_MS` (60 s), doubling (×2, ×4, …) on each repeat up to ×32, and
  resets the counter to zero for the next window.
- Refusals are `429` with `too many attempts; try again later`.

### Metered-tool quotas — `src/rate/fixedWindowQuota.ts`

Billable or compute-heavy tool calls run on a different mechanism than the
credential throttle: a **per-user fixed-window quota** whose successful calls
stay counted (there is no "failure" to forgive — the budget renews only when
the window lapses). Refusals are returned to the model as retry text ("try
again in Ns") rather than erroring the turn. The generic machinery is
`FixedWindowQuota`; each tool instantiates its own.

| Tool                             | Quota          | Budget                                                 |
| -------------------------------- | -------------- | ------------------------------------------------------ |
| `analyzeImage` (vision analysis) | `vlLimiter`    | `JARVIS_ATTACHMENT_VL_CALLS_PER_MIN` (10/min per user) |
| `webSearch` (#9)                 | `searchQuota`  | `JARVIS_SEARCH_CALLS_PER_MIN` (20/min per user)        |
| `getWeather` (#31)               | `weatherQuota` | `JARVIS_WEATHER_CALLS_PER_MIN` (10/min per user)       |
| `homeAssistant` (#15)            | `haQuota`      | `JARVIS_HA_CALLS_PER_MIN` (10/min per user)            |
| `wikipedia` (#8)                 | `quota`        | `JARVIS_WIKIPEDIA_CALLS_PER_MIN` (20/min per user)     |

The first four are **per-user only**: they refuse a guest outright (a guest has
no verified `userId` to charge). `wikipedia` is the exception — it needs no
credential and costs nothing, so it also admits guests, who are metered by a
**second mechanism** built on the same primitive. A guest call must clear
**both** of these buckets (the `FixedWindowQuota` keys are namespaced strings,
`"session:<id>"` / `"address:<ip>"`, which is why the class is generic over its
key type):

| Guest budget | Key            | Budget                                       | Purpose                                                     |
| ------------ | -------------- | -------------------------------------------- | ----------------------------------------------------------- |
| per session  | `session:<id>` | `JARVIS_WIKIPEDIA_GUEST_SESSION_PER_MIN` (3) | bounds one conversation                                     |
| per address  | `address:<ip>` | `JARVIS_WIKIPEDIA_GUEST_IP_PER_MIN` (10)     | bounds a guest who opens a fresh socket for a fresh session |

This mirrors the credential throttle's per-username + per-IP pair: the
per-session bucket alone is not enough, because a guest chooses its own
`sessionId` and could rotate it to reset the budget. The `address` key is the
socket's peer address (`request.socket.remoteAddress`, captured at handshake),
so behind a reverse proxy it collapses toward one global bucket — the same
`req.ip` caveat [below](#scope-and-caveats), tracked with
[#63](https://github.com/LukeStanbery89/jarvis-v2/issues/63).

### Sandbox broker — per-job request quota — `src/sandbox/proxy.ts`

A coding job's agent talks to the credential broker rather than to the
provider, and the broker counts **accepted requests per job**
(`JARVIS_SANDBOX_PROXY_MAX_REQUESTS`, default 500). Past the cap it answers
`429` with `insufficient_quota`. The counter lives in memory and is dropped
once the job is no longer running, so it is a lifetime budget for one job, not
a rate.

It is deliberately neither `RateLimiter` (that throttle guards password
guesses and clears on success) nor `FixedWindowQuota` (a job has no window to
renew into — the budget is meant to end with the job). The broker also caps a
request body at 8 MiB and refuses any model other than the configured one,
which together with the token's job scope is the cost bound the broker exists
to enforce.

### Notification delivery budget — `src/notify/service.ts`

Not a tool quota, but the same primitive for a different resource: a
per-user, per-minute ceiling on how many notifications may be **pushed** to
that user's live sockets (`JARVIS_NOTIFY_DELIVERIES_PER_MIN`, default 20). A
notification past the budget is still recorded and still shows up in
`GET /api/notifications` — the budget bounds interruption, not storage, which
is what keeps a misbehaving producer from turning a chat client into a
firehose without ever losing the message.

Two properties make it behave unlike the tables above. The budget is only
charged when there is somebody to interrupt: a notification raised while the
user has no live socket is left `pending` and spends nothing. And a suppressed
notification is not an error the caller has to handle — `POST
/api/notifications` answers 201 with `suppressed: "cap"` (or `"disabled"`,
`"quiet-hours"`, `"absent"`), so the producer learns what happened without a
failure. Quiet hours come from the user's `notify.quietHours` pref and are evaluated
against the **server process's clock**, not a per-user timezone: JARVIS is a
home server that normally shares its user's clock, and a deployment that does
not (the container defaults to UTC — see `TZ` in `docker-compose.yml`) would
otherwise be quietly wrong. A per-user timezone is the tracked follow-up.

A held-back notification is **never re-announced when the window ends**. The
gate is evaluated once, at raise time; nothing watches the clock, so there is no
event at 07:00 to push anything. That is deliberate rather than unfinished:
re-pushing a night's worth the moment quiet hours lift is a burst of exactly the
interruptions quiet hours exists to prevent. What the user gets instead is the
durable record, shown on their client's next contact with the server — never
pushed, but never lost. (A single digest at the window's end is the shape if
that is ever wanted; it needs a timer, which is #90.)

Retention is the other half: `JARVIS_NOTIFY_MAX_PER_USER` (default 200) trims on
every insert, evicting settled rows first — an undelivered notification is the
last thing a prune takes, but it is not exempt, because the rows that pile up
most easily are precisely the `pending` ones nobody was online to receive.

**A dismissal deletes the row** (#90 phase 9c), which is the one lifecycle
decision this section owns. `dismissed` used to be a terminal state a row sat in
— hidden from the list, but on record — and a row kept to record a shrug is a row
nobody reads. So `POST /api/notifications/{id}/dismiss` removes it, `dismissed`
left the state vocabulary (a v16 rebuild deletes the rows that were in it, and
reports how many), and there is no `includeDismissed` read to ask for them. Two
consequences worth stating: a dismissal is idempotent in the sense that a row
already gone is what the call wanted (the second one answers 404, like a foreign
id), and the supersede path is a delete too — which is what keeps a series that
repeats every minute at one live row rather than a thousand tombstones.

### Scheduled-job model-run budget — `src/scheduler/runner.ts`

The one budget here that is **not** in memory. A repeating `prompt` job is a
standing order to call the model — the thing recurrence makes possible that
nothing bounded before — so the runner charges every firing that reaches the
model against a per-account, per-**local**-day ceiling
(`JARVIS_JOB_MODEL_RUNS_PER_DAY`, default 200), counted in the auth database
(`job_model_runs`, one row per account per day).

Two properties make it a budget rather than a throttle, and both are the reason
it is a row and not a counter:

- **It survives a restart.** An in-memory ceiling would reset at exactly the
  moment a runaway job resumes spending — when the box comes back. The same
  argument retires the other two mechanisms here: `RateLimiter` is failure
  backoff, and `FixedWindowQuota` counts successes per process.
- **It charges only what costs.** A `message` or `tool` job never calls the
  model, a quiet-hours deferral never runs, a firing a gate declined spends
  nothing, and a firing whose own schedule has ended spends nothing — so none of
  them touch the budget. It is checked before the claim, and so before the gate:
  a spent budget ends the job's day at the notice, because claiming a firing that
  will not run would consume one of `ends.after`'s firings.

Being spent is deliberately loud enough to be seen, once: a one-shot is settled
`missed` with the reason (its moment passed and it was not attempted, which is
what `missed` means), while a series moves to its next occurrence and posts
**one** notice for that day, deduped on `job-budget:<user>:<day>` through the
notification service's existing dedupe. A schedule that starves in silence would
be worse than the spending it prevents.

### Not rate limited

Worth stating explicitly, because these are the surfaces that cost real CPU:

| Surface                                                        | Bounded by                                                                                                                            | Not bounded by                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `/ws` chat turns                                               | concurrency only — a per-thread lock (one turn per `sessionId`), one streaming turn per socket, and `JARVIS_TURN_TIMEOUT_MS` per turn | **prompt frequency** — a socket can submit turns back-to-back indefinitely |
| REST resources (`/api/users`, `/api/devices`, `/api/prefs`, …) | authentication and ownership checks                                                                                                   | any request-rate ceiling                                                   |
| Notification **records** (`POST /api/notifications`)           | the per-user delivery budget above (which bounds pushes), plus retention                                                              | how many notifications may be _stored_ per minute                          |

The `/ws` gap is tracked in [#65](https://github.com/LukeStanbery89/jarvis-v2/issues/65).
Guest sockets (a `/ws` socket that sends a prompt without an `auth` frame) are
unauthenticated and therefore the most exposed. Their chat **turns** are still
unbounded, but the guest-admitting `wikipedia` tool caps its own calls per
session and per address (see the quota table above), so a guest cannot use that
tool as an unbounded outbound-request amplifier.

### Scope and caveats

- **State is in-memory only**, per process — with one deliberate exception: the
  scheduled-job model-run budget is a row in the auth database, because a restart
  must not hand the day's allowance back (see its section above). The server is
  single-instance by design, so this is adequate for the LAN posture; a process
  restart simply resets every other counter. There is no distributed state.
- **The credential throttle trusts `req.ip` as-is.** Behind a reverse proxy every request
  appears to originate from the proxy, which collapses the per-`ip` budget into a
  **global** lockout — one attacker locks out everyone. Set
  `app.set("trust proxy", …)` when fronting the server with a proxy. Tracked in
  [#63](https://github.com/LukeStanbery89/jarvis-v2/issues/63).
- **Prefer identity keys for new limiters.** Any throttle added later should key on the
  resolved user identity rather than `req.ip`, so it is correct behind a proxy by
  construction.
- `RateLimiter` is deliberately **not** reused for quotas. Its `admit()` increments on
  every call and `recordSuccess()` deletes the key, so a success-and-release cycle
  counts against the budget — wrong semantics for "N per minute" or "N bytes held".

## Image analysis

Chat prompts can reference uploaded images (#10). The chat model is text-only;
it answers image questions by delegating to a vision-language (VL) model
through the `analyzeImage` tool — the analysis text is all that reaches the
conversation, never the image bytes.

```
 web composer                        server                            LM Studio
 ────────────                        ──────                            ─────────
 📎 / paste / drag-drop
   downscale if over budget ────────▶ POST /api/attachments
   (pure policy + canvas adapter)      requireAuth + requireCsrf
                                       magic-byte sniff, byte caps
                                       ◀── 201 { attachmentId }
 prompt { attachments: [id] } ──────▶ ws.ts: auth required for image prompts;
                                       ids validated BEFORE the turn claims
                                       the thread (unknown/expired/foreign
                                       → immediate error frame)
                                       └─▶ model sees [attachments: …] and
                                            calls analyzeImage ──────────▶ VL model
                                            ◀── analysis text ────────────  (non-streaming)
                                       ◀── chunk … done
```

What the surface guarantees:

- **Authentication is required end to end.** Guests cannot upload, and a
  prompt carrying attachment ids on a guest socket is refused _before_ the
  session ledger row is claimed. The VL-call quota, byte budgets, and
  ownership checks all key on the authenticated `user.id`.
- **Bytes are transient by design.** Uploads live under
  `<tmpdir>/jarvis-attachments` (private-mode verified at use — a
  group/other-accessible root fails startup of the store loudly), expire
  after `JARVIS_ATTACHMENT_TTL_MINUTES`, and are swept at boot (files from a
  previous process are orphans nothing can resolve) and after each upload.
  Transcripts keep only the ids — a reloaded thread shows "image not
  retained" rather than a preview.
- **Quotas are not rate limiting.** The VL-call limiter (per user, per
  minute), the per-user byte ledger, and the upload semaphore are quota
  mechanisms with different semantics than the credential throttle — see
  [Rate limiting](#rate-limiting) for the distinction and why
  `RateLimiter` is deliberately not reused here.
- **Uploads are validated by content, not declaration.** The store sniffs
  magic bytes (PNG/JPEG/GIF/WebP); a declared mime is never trusted, so
  crafted non-image bytes are refused with 403 before any storage.
- **The VL runtime must accept images.** `LLM_VL_MODEL` must name a model on
  the same endpoint that accepts OpenAI `image_url` content parts. The server
  verifies reachability at startup when configured; note that LM Studio
  builds differ in which formats their ingest accepts (the current build
  rejects WebP — the web client therefore re-encodes PNG sources as PNG and
  photos as JPEG).
- **Reasoning never leaks.** The default VL model is a reasoning model; its
  chain-of-thought is discarded and only the final analysis returns.

The web app implements the upload flow (📎, paste, drag-and-drop,
`data:` previews, one stricter-budget retry on a 413). The protocol and the
store are client-agnostic — a CLI or camera client can reference attachments
without touching the wire shape; non-browser clients cannot downscale, so
they must stay under the per-attachment cap themselves (hard-rejected above
it).

## Web search and weather

See the configuration table for `TAVILY_API_KEY`, `SERPER_API_KEY`, and `OPENWEATHER_API_KEY`; tools are registered only when their keys are configured.

## Home Assistant

The agent reads and lightly controls the user's own Home Assistant instance
through one `homeAssistant` tool (#15) over the local REST API — two endpoints,
no new dependency: `GET /api/states` for the snapshot and
`POST /api/services/<domain>/<service>` for a write. Configure
`HOME_ASSISTANT_URL` and `HOME_ASSISTANT_ACCESS_TOKEN` (plus the optional
`JARVIS_HA_*` knobs in the configuration table); with either unset the tool is
not registered at all.

- **One tool, one `action`** — `list`, `lights`, `switches`, `get`, `turn_on`,
  `turn_off`, `toggle`, `set_brightness`, `set_temperature`. The two discovery
  actions paper over the fact that a light is not always the `light` domain:
  `lights` matches the `light`/`switch` domains against `JARVIS_HA_LIGHT_TOKENS`
  over id and friendly name, and `switches` drops `_led` shadow children.
- **Reads are broad, writes are narrow** — reads span lights, switches,
  climate, fans, sensors, covers, media players and locks
  (`JARVIS_HA_READ_DOMAINS`); writes are limited to light/switch/climate/fan
  (`JARVIS_HA_CONTROL_DOMAINS`), a strict subset. Locks, covers, scenes,
  buttons and scripts stay readable but not controllable.
- **A write reports the accepted action, never a verified state** — every
  write resolves `entity_id` against the live snapshot and is checked against
  the control domains, the action's required domain, and the entity's own
  state (`unavailable`/`unknown` is refused) before any HTTP, and the 2xx body
  (dispatch-time state, not the outcome) is discarded. The model is told to
  call `get` for current state; writes are logged at info as an audit trail.
- **Metered and bounded** — `JARVIS_HA_CALLS_PER_MIN` (10/min) through the
  shared fixed-window quota and `JARVIS_HA_TIMEOUT_MS` (10 s) per call; the
  token is a `Bearer` header only, never in a URL, a log line, or error text.

The full per-bullet rationale, the snapshot-caching rules, and the
untrusted-input handling live in the `packages/server/src/README.md` file map
(`llm/tools/homeAssistant.ts`, `llm/tools/homeAssistant/client.ts`).

## Wikipedia

The agent looks up encyclopedic topics through one `wikipedia` tool (#8) over
the public MediaWiki Action API — one request on the common path, no
dependency, no API key. Because there is no credential to gate on, this is the
one optional tool that is **enabled by default**; `JARVIS_WIKIPEDIA=off`
removes it.

- **One request on the common path.** A `generator=search` query resolves the
  best title _and_ fetches its extract in the same response. A second
  `list=search` request happens only when the top hit is unusable (a
  disambiguation page, or a hit with no extract): the model is handed candidate
  articles to choose between, or to narrow the query against, instead of a
  body to answer from. The rejected page is dropped from that list — the
  fallback search usually ranks it first, and it is by definition not an
  answer.
- **Two depths.** `detail: "summary"` (the default) returns the lead extract
  (`exintro`, bounded by `JARVIS_WIKIPEDIA_MAX_SENTENCES`, which the API caps at
  10). `detail: "full"` returns the article's plain text cut to
  `JARVIS_WIKIPEDIA_MAX_FULL_CHARS`; the result states how much was omitted and
  links the full article, so the model never presents a partial extract as
  complete. Per-section retrieval is deliberately not attempted — it would
  mean `action=parse` and stripping tens of KB of HTML per section.
- **Descriptive `User-Agent` is required.** Wikimedia's policy requires an agent
  that identifies the client; `JARVIS_WIKIPEDIA_USER_AGENT` defaults to this
  project's URL. An empty agent is answered `403`.
- **Metered, and the only guest-admitting tool.** Signed-in callers use
  `JARVIS_WIKIPEDIA_CALLS_PER_MIN` (20/min); guests — who have no account to
  charge — are metered by **two** buckets that must both admit, a strict
  per-session one and an aggregate per-address one. See the
  [metered-tool quotas](#metered-tool-quotas--srcratefixedwindowquotats) table.

The request/response normalization and the defensive parsing live in the
`packages/server/src/README.md` file map (`llm/tools/wikipedia.ts`,
`llm/tools/wikipedia/client.ts`).

## Preferences — `/api/prefs`

`GET /api/prefs` / `PUT /api/prefs` are a **free-form per-user map**: string
keys (1–256 chars, at most 64) to any JSON value. It is where integrations keep
their own settings, and the portal's raw JSON editor is the escape hatch for
them. `PUT` upserts only the keys it names, so a client patches one setting at a
time; `DELETE` clears **every** key on the account and is not a way to unset
one.

A key the server _itself reads_ is a different matter, because a setting in a
shape the reader cannot parse saves fine and then silently does nothing — the
"nothing happened" failure class #139 exists to remove. So writes to those keys
are validated (`src/prefs/known.ts`) and a malformed value is a **400 carrying
the reason**, to whoever wrote it (the web panel, the portal's raw editor, or
`curl`). A rejected body stores nothing at all: a prefs write is all-or-nothing.

The two keys read today, both by the notification service:

| Key                 | Value                                                | Off / unset                                                                     |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `notify.enabled`    | `true` / `false`                                     | `false` turns interruptions off (records are still kept); `null` or absent = on |
| `notify.quietHours` | `{ "start": "HH:MM", "end": "HH:MM" }`, server-local | `null` or absent = off; a zero-length window is refused on write                |

The reader stays lenient (an unreadable stored value is ignored, never fatal),
so a hand-edited database can never silence a user for the day; the write check
is the strict counterpart. Both live in `packages/server/src/notify/prefs.ts`,
one definition, so a new pref shape cannot have two.

## Scheduler (#90)

The assistant's scheduling tools (#90 phase 3) can set work for later.
The queue is the `jobs` table in the app database — there is no in-memory
pending set — which is what makes a restart free: the loop simply scans for
what is due _now_, however the process got here.

```
   chat turn                          the loop (one coarse tick)
   ┌──────────────────────┐           ┌──────────────────────────────────────────┐
   │ the scheduling tools │           │ listDueJobs(now)  ← the partial index    │
   │  (setTimer etc.)     │           │      │                                   │
   └──────────┬───────────┘           │      ▼  at most JARVIS_JOB_MAX_PER_TICK  │
              │ creates               │   claim (pending → running, atomic)      │
              ▼                       │      │                                   │
   ┌───────────────────────────────┐  │      ▼                                   │
   │ jobs  (queue + state)         │◄─┤   execute: prompt → runAgent(job:<id>)   │
   │ job_runs  (what happened)     │  │            tool   → tool.invoke(runtime) │
   └───────────────────────────────┘  │      │                                   │
              ▲                       │      ▼  run row + settled job + ONE       │
              │ 1:N                   │   notification (job.finished/failed/missed)│
              └───────────────────────┴──────────────────────────────────────────┘
```

**A job is not a conversation.** Its runs execute on a `job:<id>` thread that
never claims a row in the `sessions` ledger, so they never appear in a client's
thread list; the checkpoint still gives the job memory across its own runs, and
`job_runs` is the history a page will read (phase 7).

Everything a run must not get wrong is in `scheduler/runner.ts` — the module
that owns one job's life — and the four rules worth knowing here:

- **One run row per firing; one announcement per payload run.** Every firing
  that reaches its payload ends in a run row, a job state and exactly one
  notification — with one deliberate exception (#90 phase 9b): a **plain
  `message` series** records no run row at all, because every one of them would
  hold the job's own text and a minutely reminder would write 1,440 identical
  rows a day. The job row is the record there (`attempts` counts the firings,
  `last_error` the last failure), and a failure, a gate's answer or a one-shot
  still files its row. The announcements are: `job.finished` with the reply, `job.failed` with the reason, or
  `job.missed` when its moment passed while the server was down. A scheduled job
  that does nothing visible is the "nothing happened" class #139 exists to
  remove, and a _scheduled_ one has nobody watching to notice. Three firings end
  without a payload and do not announce the finished/failed pair: a slot missed
  while the server was down and an occurrence the day's model budget skipped
  leave **no** run row (nothing was begun), while a firing a **gate** declined
  leaves a `skipped` row and says nothing (nothing changed, which is what the
  user asked to be told about). The budget's one deduped notice is the sole
  exception, and it exists because a schedule starving in silence would be worse
  than the spending it prevents.
- **A claim is the transition.** `state = 'pending'` lives in the claim's WHERE
  clause, so a second tick — or a process that restarted mid-run — touches no
  row. The same statement is why an overlapping tick is safe.
- **Lateness is honest.** Within `JARVIS_JOB_MAX_LATENESS_MS` a job runs late;
  beyond it, it is `missed` and says so rather than firing into a moment that
  has passed. A `running` row found at boot was left by a process that died
  (a claim lives in memory), so the first thing `start()` does is fail it with
  "the server restarted while this run was in progress" — announced like any
  other failure.
- **A message job runs nothing.** The job's own text is the whole payload: a
  reminder or a timer needs no model and no tool, and the runner's announcement
  is what delivers it — which is why `sendNotification` stays unschedulable
  (one job, one notification). The job's `class` travels with that announcement
  unchanged, so a `timer` pierces quiet hours while everything else waits.
- **The log says whether the user was actually told.** A run's announcement is
  logged at `info` whenever it was _recorded but not pushed_, with the reason:
  `job notif1 "Filter" recorded only (quiet-hours) — quiet hours hold a
notification`. Silence at `info` therefore means it was delivered (the
  delivery itself is a `debug` line), so "it ran but nothing appeared" is
  answered by the log rather than by a debug rerun.
- **A reminder defers itself out of quiet hours.** Rather than being held (and
  forgotten) or firing into a sleeping house, a `reminder` that lands inside the
  window moves its own `run_at` to the moment the window closes — the loop
  already owns the clock, so no second timer is involved — and keeps its attempt
  count at zero, because nothing was attempted. A `timer` pierces instead, and a
  `notification` records its announcement and waits to be read. The window
  arithmetic and the "which class is held" answer live in `notify/prefs.ts`, so
  the service and the scheduler cannot disagree about when quiet hours end. The
  window is read **live**, never copied onto the job: moving quiet hours before
  a reminder's moment changes the decision, extending them over an
  already-deferred moment defers it again, and clearing them does not bring the
  job forward — the original moment is not retained, so a deferral is one-way.
  With `notify.enabled: false` there is nothing to defer _for_, so the job runs
  at its own moment and the record is produced then rather than hours late.
- **The boot log names the database.** `App database: <path>` sits beside the
  checkpoint line, because "the scheduler never fired" and "the row was inserted
  into a different file" are indistinguishable from the outside — that happened
  once (2026-10-17) and cost a round trip.
- **A tool job runs the tool, not the model.** The `tool` payload invokes the
  named tool with the runtime a graph turn would have stamped
  (`configurable.sessionId`/`userId`, the turn's `AbortSignal`), so the quotas,
  ownership checks and quiet-hours policy inside that tool apply unchanged. The
  allowlist in `scheduler/tools.ts` decides what may be named — it excludes
  `sendNotification` (the runner already announces every run, so scheduling the
  notification tool would announce twice) — and it is checked again at fire
  time, because a server's configuration can change between scheduling and
  firing.

### Repeating jobs (#90 phase 8c)

A job may carry a **rule** (`JobRepeat`, validated and computed by
`@lukestanbery/jarvis-protocol` — the same function the web form previews with,
so a preview cannot disagree with what happens). It stays **one row**: the rule
holds the schedule and the row's `run_at` is always the next occurrence, so the
id a conversation named an hour ago is still the id to cancel.

- **The anchor is the rule's, not the run's.** `start` carries the wall clock
  the series fires at, and a re-arm always computes from it — which is why a
  snooze (+1h) or a quiet-hours deferral (to 07:00) moves _one_ firing and the
  series returns to its own clock afterwards.
- **Re-arming is part of the settle.** The run row and the job's next state
  (owed again, or terminal) commit in one transaction, so a process that dies
  mid-run can never leave a series without a successor. A **failed** firing
  re-arms too: for a series, the next occurrence is the retry.
- **Skips are quiet, endings are not.** A slot that passed while the server was
  down moves a series forward silently rather than announcing a `missed` firing,
  and a firing interrupted by a restart re-arms rather than failing the series —
  the occurrence is lost, the schedule is not. A series that runs out (`until`,
  or `after: N` firings — a skip does not consume one) settles `done`.
- **Stopping it is a cancel.** A cancel that lands mid-run wins: the firing in
  flight still reports, and the re-arm refuses to schedule a successor.

Impossible dates are decided in three tiers rather than one, and the tiers are
the reason a rule can be _refused_ instead of quietly doing something else: a day
the month does not have is clamped to its last day, an ordinal that month does
not have ("the 5th Monday") skips the month and the create flow says when the
next one is, and something that can never exist ("the 32nd", "the 7th Monday") is
refused. See the rule's own doc for the full semantics.

### The gate (#90 phase 8f)

A job that fires every five minutes cannot afford a model call every five
minutes, and a reminder cannot afford to speak every five minutes. So a job may
carry a **gate**: one read-only tool call, made by the runner _before_ any
payload, whose answer is compared with the answer the previous firing recorded.

```
fire → claim → gate (one read) ─┬─ same question, same answer → run row `skipped`
                                │                               no payload · no announcement
                                └─ different (or no baseline)   → payload runs, announced
                                                                  and the answer is recorded
```

- **Only `changed` exists.** A richer condition is either a predicate language or
  a model call; half of one would be worse than an honest refusal.
- **Gateable is declared, not inferred.** `homeAssistant` mixes reads and writes
  behind one name, so `scheduler/tools.ts` lists the actions that only read
  (`list`/`lights`/`switches`/`get`); a tool absent from that map cannot be a
  gate, and the refusal reaches the conversation when the job is created and the
  run when it fires. The read-only tools are deliberately absent for now: a
  `changed` gate over `webSearch` would answer differently on every poll and
  turn an affordable job into a flood. An entry is a promise that the answer is
  stable while nothing changes.
- **The answer is recorded on every gated firing**, not only the declined ones:
  the comparison reads the newest run, so a payload run that recorded nothing
  would reset the baseline and every other firing would run. `gate_key` is the
  `{tool, args}` identity — a gate that was edited asks a _different question_,
  so its predecessor's answer is not evidence and the payload runs.
- **A check that cannot be made fails the firing.** The tool may be gone at 3am,
  or the stored value may name a write; "only if it changed" is not a request to
  run regardless, so the refusal goes in the run row and in the failure — the
  same shape a tool job gets when its target has vanished. A _structurally_
  unreadable gate (a stored value that no longer parses) is a different case and
  runs the job unguarded with a warning, as an unreadable `repeat` rule fires
  once: the request is still the request.
- **A decline costs nothing.** No model run is charged and nothing is announced.
  The one interaction worth knowing: the model-run budget is checked before the
  claim, and therefore before the gate, so an account that has spent its day
  ends the job's day at the notice rather than at the free check — a claim spent
  on a firing that never runs would consume an `ends.after` count.
- **Skips are visible where jobs live.** A gated job that only ever declines
  produces no notification at all, so the **Runs** disclosure sits on the job row
  (owed and settled) on `/timers`, `/reminders` and the notifications page's
  Scheduled half — the first place a timer's own history is reachable too.

### The scheduling tools (#90 phase 3; `repeat` in 8d)

`remindMe` and `scheduleTask` take an optional **`repeat`** (#90 phase 8): the
same rule object the REST surface sends, minus its anchor. The model states the
schedule in fields — `every`/`interval`, `weekdays` for "every Monday and
Saturday", `monthDays` for "the first of the month", `weekOrdinals` for "the
second Tuesday", `ends.after` for a count — and names _when_ in words, exactly as
it always has; the resolver turns those words into the first occurrence, which
becomes the rule's `start`. The model never handles a timestamp, and a series
still fires at the clock the user said.

Two things the tool text does deliberately. It **states the schedule back**
("Reminder scheduled: … repeating every Monday, Tuesday and Saturday at 09:00")
alongside when it will next run, because a small local model writing `weekOrdinals`
by hand is exactly where a silent mistake would land, and reading it back lets
the user correct it in the same turn. And the scheduling hygiene paragraph tells
the model to **ask rather than choose** when a phrase could mean two schedules —
"every Monday and the 1st" is either every Monday plus the 1st or a Monday that
is also the 1st — which is the one ambiguity the rule cannot resolve for it.

### The scheduling tools (#90 phase 3; the gate in 8g)

Seven tools, and their split is the policy: **the class comes from which tool was
called, never from an argument**, so nothing the model writes can choose how
loudly the user is interrupted.

| Tool             | Class                                  | Payload        | Time                                     | `gate`   |
| ---------------- | -------------------------------------- | -------------- | ---------------------------------------- | -------- |
| `setTimer`       | `timer` — pierces quiet hours          | message        | `minutes` or `seconds` (1 s – 24 h)      | —        |
| `remindMe`       | `reminder` — defers out of quiet hours | message        | `at` + optional `onDate`, or `inMinutes` | optional |
| `scheduleTask`   | `notification` — waits                 | one tool call  | same as `remindMe`                       | optional |
| `schedulePrompt` | `notification` — waits                 | one prompt     | same as `remindMe`                       | optional |
| `snoozeReminder` | keeps the reminder's class             | same as before | `id` + `minutes`                         | —        |
| `listJobs`       | —                                      | —              | —                                        | —        |
| `cancelJob`      | —                                      | —              | —                                        | —        |

`schedulePrompt` (#90 phase 8g) is the door to a job that _does_ something rather
than one that runs a single tool: "every night, summarise my day", "each morning
at eight, brief me on the news". It was the last payload kind with no way in —
the runner has run `prompt` jobs since phase 1, and the REST surface stays
message-only by decision — so its prompt is written to stand on its own, because
nobody is there to answer a question when it fires. The reply becomes the job's
announcement, filed as the class it is: a `notification`.

**A gate is what makes a frequent schedule affordable** (#90 phases 8f–8g).
Every creating tool — `remindMe`, `scheduleTask` and `schedulePrompt` — takes
an optional one, and the model states it
the way it states everything else — a tool, that tool's arguments, and
`when: "changed"` — never a condition language. Three refusals arrive while the
user is still in the conversation: the tool must be one that declares a read
action, it must be installed on this server, and its arguments must satisfy its
own schema (the same check a scheduled target's arguments get). A reminder takes
one for the same reason the other two do — "remind me every ten minutes, but only
if the oven is still on" is a conditional announcement, and a `message` job's
floor is a minute precisely because a firing that declines says nothing. What the
gate buys a _spending_ job is the **cadence floor**: a job that runs a tool or a prompt may not repeat
faster than every 15 minutes unless it carries a gate, because every firing is a
device write or a model call — a gated one may go to a minute, since a declined
firing does nothing. The reply says both halves ("repeating every 5 minutes, but
only when homeAssistant changes"), so the user can correct a condition they did
not ask for in the same turn.

**A series keeps one live announcement** (#90 phase 9a), which is the other half
of the floor: a firing's announcement carries a dedupe key of its job's id, so
each one _replaces_ the previous rather than stacking. A reminder every minute is
one row in the list that keeps saying the newest thing — not 1,440 rows of the
same sentence — and the toast stack collapses by job for the same reason. That is
why a `message` job may now repeat as often as every minute: its cadence is no
longer a notification rate. A `tool`/`prompt` job keeps its 15-minute floor
because what it spends per firing is real, and a gate — which declines before
spending — is the way past it.

**The cadence arrives in whichever spelling the model reached for** (fixed after
the first live run of a repeating reminder). The nested object — `repeat`, the
shape a page sends and the row stores — is one way to say it; the same fields at
the top level are the other, and the live run produced exactly that
(`{ label: "Drink water", every: "minute", interval: 30 }`). Because `z.object`
_strips_ what it was not told about, that call lost its schedule silently and came
back as "no time was given" — a refusal the user could only answer by repeating
themselves. Both spellings are read into one object (`statedCadence`), the nested
one winning when a call states both, and the fields are still defined once
(`cadenceFields`).

**A cadence is its own when.** When the model names no time and the user asked
for a repeat, the rule is anchored at the moment of the ask and `nextOccurrence`
picks the first firing: "every 30 minutes" starts half an hour from now, "every
day" starts tomorrow at this time. The result states it back ("… today at 7:35
PM, in 30 minutes"), so a clock time they meant differently is corrected in the
same turn. A **one-shot** with no time is still refused — there is nothing to
derive one from, and that is the "later"/"soon" case the prompt tells the model to
ask about rather than guess.

**Times are words, not timestamps.** The model passes what the user said — a
24-hour clock time, `today`/`tomorrow`/a weekday/a date, or a delay — and
`scheduler/time.ts` turns that into one instant in the server's local zone: a
bare clock time means the next time the clock reads that, a time that passed
seconds ago still means today, a weekday rolls forward, and an explicit past
date is refused. That is also why the prompt tells the model not to convert
times itself.

**Impossible tasks fail at creation.** `scheduleTask` checks the requested tool
against `scheduler/tools.ts` (so `sendNotification`, `analyzeImage`, and the
scheduling tools themselves are refused) _and_ against that tool's own schema, so
"the homeAssistant tool needs different arguments — entity_id: …" arrives while
the user is still in the conversation rather than at the due moment with nobody
watching. The runner re-resolves the tool when it fires, because a server's
configuration can change in between.

**The bounds are the queue's.** `JARVIS_JOB_MAX_PER_USER` caps _pending_ rows
(the runner's retention prune evicts settled rows first, so a job the tool
accepted cannot be the row the prune eats), `JARVIS_JOB_MAX_HORIZON_DAYS`
(default 366) refuses a moment too far out to be anything but a typo, and a
label or message longer than a notification can carry is refused rather than
truncated. Every refusal is model-facing text and leaves no row behind.

**The result says what will happen, not what was asked.** A reminder that lands
inside quiet hours is told so — "it will wait until 7:00 AM and be announced
then" — from a live read of the prefs, without pre-deferring (the runner owns
that decision). A timer says it will interrupt; a notification says it will be
recorded and wait. A job whose text is only its headline arrives as one line,
not a headline repeated as the body.

**Snooze is a move, not a new kind of thing.** A reminder that has not fired
moves its own `run_at` (`moveJob`, owner-scoped and pending-only, in one
statement); one that already had its moment is re-created with the same text for
the new time. A running reminder is refused (it is being worked on), a cancelled
one is refused (cancelling was an explicit "don't tell me"), and a timer or a
notification is refused because only a reminder snoozes. No schema change is
involved: the notification list's own _snoozed_ state belongs with the list that
can show it (phase 6).

The tools are registered only when the scheduler is running (`JARVIS_SCHEDULER`
not `off`, notifications wired): a job nobody can run is a promise the server
cannot keep. The pages come next (phases 6–7), and recurrence (per-job
timezones, DST, retries) last.

### Managing jobs over REST (#90 phase 5)

`/api/jobs` is the surface a page manages timers and reminders through, and it
is **the same policy as the tools**, not a second one: `scheduler/create.ts`
owns what a job may be (the label/message bounds, the horizon, the per-user cap
on pending rows, the timer's day ceiling), what an edit may touch, what a snooze
means, and the quiet-hours forecast. The tools render its answers in the model's
voice; the routes map its refusal codes onto status codes. Mounted only when
the scheduler is wired, so `JARVIS_SCHEDULER=off` leaves no endpoint rather than
one that cannot honour what it stores.

| Method   | Path                    | Description                                                                    |
| -------- | ----------------------- | ------------------------------------------------------------------------------ |
| `GET`    | `/api/jobs`             | The caller's jobs, newest first (settled ones only with `includeSettled=true`) |
| `POST`   | `/api/jobs`             | Schedule a `message` job: `{ label, class, message?, runAt, repeat? }`         |
| `GET`    | `/api/jobs/{id}`        | One job plus its run history (`{ job, runs }`)                                 |
| `PATCH`  | `/api/jobs/{id}`        | Edit `label`, `message`, `runAt` or `repeat` while the job is still `pending`  |
| `DELETE` | `/api/jobs/{id}`        | Cancel a `pending` job, or stop a **repeating** one mid-run                    |
| `POST`   | `/api/jobs/{id}/snooze` | `{ minutes }` — move a pending reminder, or set a settled one again            |

Three things about that surface are worth stating, because each is a decision
rather than an implementation detail:

- **A page may name a class; the model may not.** `class` is accepted in the
  create body because a page is the user's own hand — a form that offers "timer"
  and "reminder" is the user choosing how loudly to be interrupted. The model's
  tools each own their class and expose no such argument, because a model that
  could name one could pierce quiet hours by asking.
- **A page may set a rule, judged in one place.** `repeat` arrives here as the
  same `JobRepeat` object the model's tools take, and goes straight to
  `scheduler/create.ts` — so a page and a model cannot disagree about what a
  schedule is, or about why one is refused. Two refusals are this server's rather
  than the rule's: a **timer may not repeat** (a timer pierces quiet hours, and a
  repeating one would be a standing breach of them), and a job whose firing
  **spends** — a tool write or a model call — may not repeat faster than
  **every 15 minutes** unless it carries a gate (#90 phases 8g, 9a). A message
  job, which spends nothing and whose announcement replaces its predecessor, may
  repeat every minute. A repeating job's moment comes from its rule, so the
  request's own `runAt` is ignored when `repeat` is present, and `PATCH`'s
  `repeat: null` is how a series is stopped (`absent` leaves the schedule alone).
- **A page-created job is always a `message` job.** Text with nothing to run is
  what a timer or a reminder actually needs. Scheduling a _tool_ or a _prompt_
  stays with the model's tools, where the allowlist and the target tool's own
  schema are checked before the row is written — a stored tool call is a durable
  capability, and a REST form has no schema to validate one against.
- **Times are instants here, words there.** `runAt` is an ISO-8601 instant (the
  output of a picker), while the model speaks times as words through its tools.
  Both end at one instant, but only the words need the resolver. A moment in the
  past, a `timer` more than a day out, and a moment beyond
  `JARVIS_JOB_MAX_HORIZON_DAYS` are refused — the first is the only one the
  natural-language path can never produce, and it is exactly what a date picker
  can.

`quiet` on the create/edit/snooze response is what the caller's prefs will do to
that announcement as they stand: `clear`, `disabled` (the account switch is
off — the job still runs), or `held` with the instant it comes back on. It is a
prediction, not a promise: the runner reads the prefs again when the job fires,
and a change in between changes the outcome.

The link that makes the surface useful to the _notification_ list is
`notifications.job_id` (schema v11): the runner stamps each announcement with
the job that produced it, and `GET /api/notifications` returns it as `jobId`. It
is what lets a fired reminder's banner offer _snooze_ rather than only
_dismiss_ — the client would otherwise have to guess which job a row came from,
and a job is pruned as history while the notification the user was shown stays.
The WS `notification` frame does not carry it yet; the list refresh does, and the
frame field lands with the buttons that read it (phase 6).

## Endpoints

Authoritative machine-checked tables live in `@lukestanbery/jarvis-contracts`:
the spec'd REST surface in [`docs/endpoints-rest.md`](../contracts/docs/endpoints-rest.md)
(generated from `packages/contracts/spec/openapi.yaml`, enforced at runtime by
`express-openapi-validator`) and the WebSocket channel in
[`docs/endpoints-ws.md`](../contracts/docs/endpoints-ws.md). The rows below are
the commonly-used subset for orientation (auth labels match the generated
table — "web session" is the `jarvis_session` cookie):

| Method   | Path                       | Auth                                | Description                                                                              |
| -------- | -------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET`    | `/`                        | none                                | The built web app (the front door); `Hello World` when it is not built                   |
| `GET`    | `/admin`                   | cookie session (its own gate)       | Built admin portal SPA (strict CSP)                                                      |
| `WS`     | `/ws`                      | optional device token (first frame) | Chat endpoint (WebSocket)                                                                |
| `POST`   | `/api/bootstrap`           | `x-bootstrap-token` header          | Create the first (owner) account + device token                                          |
| `POST`   | `/api/auth/login`          | none                                | Username + password → a (rotating) device token                                          |
| `POST`   | `/api/attachments`         | device token or web session         | Upload a base64 image → `{ attachmentId }` for an image-analysis prompt (transient, TTL) |
| `GET`    | `/api/me`                  | device token or web session         | Current user + their devices                                                             |
| `POST`   | `/api/devices`             | device token or web session         | Provision a new device token for the caller                                              |
| `DELETE` | `/api/devices/{id}`        | device token or web session         | Revoke a device (own, or any as owner)                                                   |
| `GET`    | `/api/users`               | device token or web session (owner) | List accounts                                                                            |
| `POST`   | `/api/users`               | device token or web session (owner) | Create an account (`role` optional, default `user`)                                      |
| `PATCH`  | `/api/users/{id}`          | device token or web session (owner) | Update `role`/`disabled` (self-disable → 400; demoting the last **enabled** owner → 409) |
| `GET`    | `/api/sessions`            | device token or web session         | List sessions (owner sees all, with `userId`)                                            |
| `DELETE` | `/api/sessions/{threadId}` | device token or web session         | Delete the caller's owned session (owner: any)                                           |
| `GET`    | `/api/jobs`                | device token or web session         | List scheduled jobs, newest first (`includeSettled=true` for history)                    |
| `POST`   | `/api/jobs`                | device token or web session         | Schedule a message job (`label`, `class`, `message?`, `runAt`), with a quiet forecast    |
| `GET`    | `/api/jobs/{id}`           | device token or web session         | One job and its run history                                                              |
| `PATCH`  | `/api/jobs/{id}`           | device token or web session         | Edit a pending job's `label`/`message`/`runAt`                                           |
| `DELETE` | `/api/jobs/{id}`           | device token or web session         | Cancel a pending job                                                                     |
| `POST`   | `/api/jobs/{id}/snooze`    | device token or web session         | Snooze a reminder (`minutes`): move it, or set a settled one again                       |

"Device token" auth is `Authorization: Bearer <token>`; the web session is the
`jarvis_session` cookie (+ `x-csrf-token` on state changes).

## Chat protocol

The wire protocol (frames, limits, and parse/serialize logic) is defined once
in the shared `@lukestanbery/jarvis-protocol` package (machine-readable mirror:
`packages/contracts/spec/asyncapi.yaml`); connect a WebSocket client to `/ws`
and exchange JSON text frames:

- Client → Server:
    - **Optional, first frame only:** `{ "hello": true, "capabilities": ["markdown", "html", "image", "link", "audio"] }` (shape
      `{ "type": "hello", "capabilities": [...] }`) — the client announces how it renders responses. Each token is
      one of `markdown` / `html` / `image` / `link` / `audio` (duplicates and unknown tokens are rejected; the list may be
      empty). This affects the agent's system prompt: the model is told the client renders Markdown/images/links
      (or that it only shows plain text). Regardless of capabilities, the server always appends seven fixed hygiene paragraphs to the system prompt — make exactly one tool call at a time with every required argument as well-formed JSON and wait for each result; make exactly one `getCurrentTime` call per time/date/weekday ask, passing the user's question verbatim; for attachment-carrying prompts, call `analyzeImage` with the exact id from the message's `[attachments: …]` list and answer from the tool's description, never by guessing; for home automation, use `homeAssistant` only as its description allows and report failures plainly; for factual or fast-changing questions, prefer a lookup tool such as `wikipedia` or `webSearch` over memory; and for anything scheduled, use the scheduling tool that matches what the user asked for and ask them when to run it instead of guessing a time. Must be
      the very first frame.
    - **First frame (or immediately after `hello`), optional:** `{ "type": "auth", "token": "<device token>" }`
      — authenticates as an account. The server replies with one
      `{ "authResult": { "user": "<name>", "device": "<name>" } }` frame. Never
      authenticate → the socket is a **guest** (ephemeral, identity-independent
      chats).
    - `{ "prompt": "<your prompt>", "sessionId": "<id>", "mode": "text"|"voice", "attachments": ["<id>"] }` —
      the `sessionId` names the conversation thread. Reuse it to continue an earlier
      conversation (bounded to 128 characters); each distinct id is isolated.
      The optional `mode` (default `"text"`) picks the chat style: text prompts
      are answered using the client's declared capabilities, while voice prompts
      always yield plain conversational text plus the spoken-word directive —
      the system prompt tells the model to write as it would speak (no
      markdown, no parentheses, spelled-out units) because the reply will be
      read aloud. Scoped to the turn: a later text prompt on the same thread
      renders richly again. The mode is recorded as the
      session's `kind` when the thread is first claimed (write-once).
      A `hello` or `auth` frame arriving after this is rejected.
    - `{ "type": "location", "lat": <number>, "lon": <number>, "label"?: "<place>" }` (#31) —
      the device's whereabouts (any time, refreshable; the latest report wins
      for subsequent turns). Feeds the `getWeather` tool so a locationless
      "what's the weather?" works without asking for a city. Kept in memory
      for the socket's lifetime only; never persisted. See [Weather](#web-search-and-weather).
    - `{ "type": "cancel" }` (#84 P6) — drop the socket's in-flight turn
      (barge-in or the stop button). Valid any time and idempotent: with no
      turn in flight it is ignored (no reply). The server aborts the model
      stream for real (`AbortSignal` threaded into the graph, so even a
      stalled model read rejects), drops the turn's spoken audio, releases
      the thread lock, and ends the turn with a terminal `{ "done": true }`
      — the text already streamed stays in history, and no error frame is
      sent.
- Server → Client (in order, per prompt):
    - `{ "tool": { "name": "<tool>", "args": { ... } } }` — the agent is calling
      a tool (emitted once per call).
    - `{ "toolResult": { "name": "<tool>", "output": <any> } }` — the tool returned.
    - zero or more `{ "chunk": "<text>" }` frames — the streamed answer.
    - `{ "done": true }` — the response is complete.
- On invalid input or model failure: `{ "error": "<message>" }`, followed by `{ "done": true }`
- Sending a new prompt while a response is still streaming — or while another
  socket is running a concurrent turn on the same `sessionId` (per-thread lock)
  — is rejected with an `in progress` error frame.
- A `sessionId` owned by a different principal — another account, or a guest's
  thread — is rejected with a `session belongs to another user` error frame:
  knowing a `sessionId` alone is never enough to read or continue a
  conversation you don't own. Sessions are only ever usable by their owner.
- Turns are hard-capped by `JARVIS_TURN_TIMEOUT_MS` (default `120000`): a turn
  that exceeds it is aborted and the client receives a `turn timed out` error
  frame. Draining is **best-effort on a hung model** — the per-thread lock
  releases once the in-flight model call settles; a client `cancel` aborts
  the same signal, so signal-honoring models stop immediately.

Every prompt is recorded in the app database (`JARVIS_DB_PATH`, default
`~/.jarvis/jarvis.sqlite`): `sessionId` is claimed atomically as a
**session** tagged `guest`/`owned` and `text`/`voice` (the kind is the
prompt's chat `mode`, recorded at first claim). Guest sessions are
deleted when their socket closes; owned sessions persist and can be listed or
deleted via the REST management API. Sockets that vanish without a close
frame (a dropped connection, a sleeping laptop) are terminated by a 30-second
ping/pong keepalive, so their cleanup — guest rows included — still fires.
Note that deleting a session removes the
ledger row, not the conversation history in the LangGraph checkpointer (see
`JARVIS_CHECKPOINT_PATH`) — that remains a documented limitation.

Concatenate the `chunk` payloads verbatim to reconstruct the full response. A
single prompt may loop through `tool`/`toolResult` pairs several times before
the agent produces its final text (bounded by `JARVIS_AGENT_MAX_TURNS`); tool
events cannot appear inside the text stream, only before it. The agent state —
including the whole message history of each session — is persisted to the
SQLite checkpoint file (`JARVIS_CHECKPOINT_PATH`), so a server restart resumes
conversations. That checkpoint file is a separate database from the auth app
database (`JARVIS_DB_PATH`); the server depends on `better-sqlite3` directly to
open it, while account state is reached only through `@lukestanbery/jarvis-auth`.
Try it with the `@lukestanbery/jarvis-cli` REPL.

## Server-side TTS (#83)

J.A.R.V.I.S. speaks its responses: text-to-speech is **server-side** (one
consistent voice for every client; clients only play audio — the mirror of
client-side STT in `packages/voice`). The engine seam, the Kokoro engine, the
response segmenter, the audio orchestrator, and the wire frames
(`audioStart`/binary PCM/`audioEnd` behind the `audio` capability) are all
shipped (#83). See the
[tracking issue](https://github.com/LukeStanbery89/jarvis-v2/issues/83) for
the strategy and its race-test matrix.

What exists now:

- `src/tts/types.ts` — the `TtsProvider` seam: text → mono float PCM +
  sample rate, with a cooperative `AbortSignal` (checked before init,
  before generate, and after; in-flight engine work cannot be interrupted,
  so the orchestrator drops aborted results by generation id instead).
- `src/tts/kokoro.ts` — `KokoroTtsProvider`, Kokoro-82M via `kokoro-js`
  (ONNX, pure local inference — no Python, no Apple-Silicon lock-in; that
  is what disqualified the MLX sketch). The engine loads through a lazy
  dynamic `import()` on first synthesis; a fake loader keeps the suite
  offline. Options: model id, dtype (`q8` default), voice (`bm_lewis`
  default), speed, and cache dir.
- `src/tts/segmenter.ts` + `src/tts/orchestrator.ts` — the turn pipeline:
  streamed tokens → sentence-boundary segments → one sequential synthesis
  worker → ordered audio, with quiet failure (the text stream is never
  disturbed) and abort on turn timeout / socket close.
- `scripts/tts-harness.ts` (`npm run tts:harness`) — the manual acceptance
  tool: synthesize `JARVIS_TTS_TEXT` (or argv), write a WAV to temp, and
  play it via `afplay`/`aplay`. Prints init/generate timings.

**Wired to `/ws`**: voice-mode prompts from a socket that declared the
`audio` capability are spoken — an `audioStart` frame, binary
little-endian s16le PCM messages (one per segment), and `audioEnd`, all
inside the turn (before `done`), so the per-thread lock covers speaking.
The model is asked to write speakably in the first place: voice turns
carry a spoken-word system-prompt directive (no markdown, no parentheses,
units spelled out — `src/agent.ts` `VOICE_FORMAT_RULE`), so the segmenter
mostly sees clean prose. Incidental markup that slips through is inert
text (it reads as written); a deterministic say-proofing pass is a
deliberate non-goal for now.

Time-to-first-audio (#89): spoken turns log a TTFA decomposition at debug
(`voice turn N TTFA: first token +Xms, first segment +Yms, first audio
sent +Zms` — deltas against the turn's start), and the web client mirrors
it in devtools (`[voice] first audio +Xms since submit, +Yms since
audioStart`). The first-audio lever is the segmenter: `JARVIS_TTS_SEGMENT`
(default `sentence`) selects clause granularity, which additionally splits
at commas/semicolons when the pending text covers at least 40 chars — the
first PCM lands at the first comma instead of the first period, at the
cost of prosody across the split (clauses are synthesized independently).
Numbers ("1,000") never split; short clauses merge into the next one so
fragment overhead cannot dominate the win. Enable it with:

| Variable              | Default    | Description                                    |
| --------------------- | ---------- | ---------------------------------------------- |
| `JARVIS_TTS_PROVIDER` | _(unset)_  | `kokoro` enables synthesis; unset = off        |
| `JARVIS_TTS_VOICE`    | `bm_lewis` | Kokoro voice id                                |
| `JARVIS_TTS_SPEED`    | `1`        | Speaking speed multiplier                      |
| `JARVIS_TTS_SEGMENT`  | `sentence` | `clause` splits at commas/semicolons too (#89) |

Deployment posture (deliberate):

- `kokoro-js` and `@huggingface/transformers` are **optionalDependencies** —
  TTS is config-gated like the optional tools, and a missing install makes
  the provider report itself unavailable; it is never a boot failure.
- Model weights are **never baked into the image**: first synthesis
  downloads the checkpoint into `~/.jarvis/tts` (created `0700` via the auth package's private-fs helpers; set via environment for local runs / `JARVIS_TTS_CACHE_DIR` only affects the standalone TTS harness — the server does not read this env var).
- The Docker prod stage installs with `--omit=optional`, so the runtime
  image neither carries the ONNX stack nor changes behavior.

## Local STT model serving (#84 P3b)

The web app's speech recognition runs **on-device** (issue #84):
a WASM engine (Vosk) in the browser transcribes the microphone locally, so
no audio ever leaves the client. The engine needs ~40 MB of model weights;
the server fetches the archive from its configured upstream on the **first
client request**, caches it privately, and streams it to browsers from its
own origin — `GET /api/stt/model` (public by design: the archive is
open-source model weights, never user data, and the recognition worker
cannot attach auth headers; browsers cache it via long-lived headers). The
archive never lands in the Docker image and is never downloaded at boot.

- `src/modelFileCache.ts` — the shared serving machinery both model routes
  use (issue #107 P3): `ModelFileCache` (lazy first fetch, per-key in-flight
  collapse, a **streamed** temp-file-then-rename write so a partial download
  never masquerades as a model and the ~40 MB archive never sits whole in
  memory, a hard fetch timeout — `DEFAULT_DOWNLOAD_TIMEOUT_MS`, 10 minutes —
  so a hung upstream cannot stall a request forever, retry on the next
  request after a failure) plus `createModelFileHandler` (200 with the
  route's `Content-Type` and `Cache-Control: public, max-age=86400`; JSON
  404 unconfigured/unknown; JSON 503 while an upstream fetch fails; optional
  `HEAD` 200 capability probe).
- `src/stt/model.ts` — the STT spec on that machinery: `SttModelCache`
  (single archive key; the cached file name is derived and sanitized from
  `JARVIS_STT_MODEL_URL`) and `createSttModelHandler` for
  `GET /api/stt/model` (200 `application/gzip`).

| Variable               | Default                              | Description                                   |
| ---------------------- | ------------------------------------ | --------------------------------------------- |
| `JARVIS_STT_PROVIDER`  | _(unset)_                            | `vosk` enables model serving; unset = 404     |
| `JARVIS_STT_MODEL_URL` | the vosk-browser small-en-us tarball | Upstream archive fetched on first request     |
| `JARVIS_STT_MODEL_DIR` | `~/.jarvis/stt`                      | Private cache directory (`0700`, file `0600`) |

## Wake-word model serving (#84 P4)

The web app's "Hey JARVIS" wake detector (openWakeWord) also runs
**on-device**. It needs three small ONNX models (`melspectrogram.onnx`,
`embedding_model.onnx`, `hey_jarvis_v0.1.onnx` — ~3 MB total); the server
fetches them from the openWakeWord release host on first request and serves
them same-origin from `/api/wake/model/:file`, because the upstream commits
no CORS headers and an SPA must load them without them. The
route is an exact per-file allowlist — an unknown name 404s before any
fetch; `HEAD` answers 200 without downloading.

- `src/wake/model.ts` — the wake spec on the shared machinery: the
  `WAKE_MODEL_FILES`/`isWakeModelFile` three-file allowlist (an unknown
  `:file` 404s before any fetch, so the route is never an open proxy),
  `WakeModelCache` (per-file keys over `ModelFileCache`), and
  `createWakeModelHandler` for `GET|HEAD /api/wake/model/:file`
  (200 `application/octet-stream` + `Cache-Control public, max-age=86400`;
  `HEAD` answers 200 without downloading).
- `src/notify/` — server-initiated messaging (#139): `types.ts` is the channel
  seam and its capability vocabulary (`canSpeak`, `canShowText`, …) so a
  satellite speaker or a phone outranks nothing it cannot do; `hub.ts` is the
  live-socket registry (`ws.ts` fills it on auth, empties it on close) that
  makes "is the user reachable?" answerable at all; `service.ts` is the policy
  (presence-first, quiet hours from the `notify.quietHours` pref — which the
  notification's `class` decides, and nothing else does, so a timer pierces
  them while a prioritised notification still waits — and the delivery
  budget above); `channels/inApp.ts` is the one phase-1 channel, pushing the
  stored record as a `notification` frame; `http.ts` is `/api/notifications`
  (list + create + read/dismiss/answer), mounted only when notifications are
  configured and refused to guests like every other account-scoped surface.
- `src/llm/tools/notify.ts` — the `sendNotification` tool (#139): the agent's
  half of that surface and the channel's first real producer. It holds no
  policy of its own — it asks `service.ts` and reports the answer — so the
  budget above bounds an over-eager model exactly as it bounds a webhook. The
  tool is registered only when the notification surface is wired, and it is
  announced to the model by a hygiene paragraph that pins restraint rather
  than use: a notification is an interruption, and one that arrives for
  everything stops meaning anything.

| Variable                | Default                                   | Description                                       |
| ----------------------- | ----------------------------------------- | ------------------------------------------------- |
| `JARVIS_WAKE_PROVIDER`  | _(unset)_                                 | `openwakeword` enables model serving; unset = 404 |
| `JARVIS_WAKE_MODEL_URL` | `…/openWakeWord/releases/download/v0.5.1` | Upstream directory each model is fetched from     |
| `JARVIS_WAKE_MODEL_DIR` | `~/.jarvis/wake`                          | Private cache directory (`0700`, file `0600`)     |
