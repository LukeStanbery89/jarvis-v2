# syntax=docker/dockerfile:1

# J.A.R.V.I.S. server image (#28).
#
# Server-only by design: the CLI, portal, and web chat client deploy separately
# (#29), so only the five packages the server actually loads at runtime are
# built into the image — `protocol`, `logger`, `auth`, `contracts`, `server`.
# The browser SPAs are NOT bundled; a deployment that wants them mounts their
# `dist/` directories and sets `JARVIS_PORTAL_DIR` / `JARVIS_WEB_DIR`.
#
# Three stages, in order of why they exist:
#
#   deps  — full install (dev deps needed to run `tsc` and the contracts spec
#           tooling) plus the build. Kept separate so editing source does not
#           invalidate the dependency layer.
#   prod  — a second, production-only install. `npm ci --omit=dev` alone is not
#           usable here: npm 12 gates install scripts behind `allowScripts`, and
#           the root `prepare: husky` script fails when its devDependency is
#           absent. `--ignore-scripts` skips that, then better-sqlite3 is rebuilt
#           explicitly (see below). This stage is also where the native addon
#           gets compiled, so the runtime never needs a toolchain.
#   runtime — `node:24-bookworm-slim`, non-root, no compilers.
#
# Verified end-to-end before merge: the built image answers `GET /health` with
# `{"ok":true}` and creates both SQLite files under the mounted volume.

# ---------------------------------------------------------------------------
# Stage 1 — install dev dependencies and compile.
# ---------------------------------------------------------------------------
FROM node:24-bookworm AS deps

WORKDIR /app

# Manifests first: this layer is only invalidated when a package.json or the
# lockfile changes, not on every source edit. All nine workspace manifests are
# copied because `npm ci` validates the whole workspace against the lockfile —
# omitting cli/portal/web makes it silently install an incomplete tree.
COPY package.json package-lock.json ./
COPY packages/auth/package.json ./packages/auth/
COPY packages/cli/package.json ./packages/cli/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/logger/package.json ./packages/logger/
COPY packages/portal/package.json ./packages/portal/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/server/package.json ./packages/server/
COPY packages/voice/package.json ./packages/voice/
COPY packages/web/package.json ./packages/web/

# `allowScripts` in the root package.json already approves better-sqlite3's
# install script, so the native addon compiles here without extra flags.
RUN npm ci

# Sources, then the build. Build order matters: the server type-checks against
# the sibling packages' emitted `.d.ts` files, so dependencies go first.
COPY tsconfig.base.json ./
COPY packages ./packages

# `contracts` is built by invoking its steps directly rather than via
# `npm run build -w @lukestanbery/jarvis-contracts`. That script interleaves
# `git diff --exit-code` drift guards (check-generated, check:endpoints) with the
# real generation steps; the guards exist to fail CI when a committed artifact
# drifts from its spec, and with no `.git` in the build context git can only fail
# spuriously (exit 129). CI still runs the full guarded build.
RUN npm run build \
      -w @lukestanbery/jarvis-protocol \
      -w @lukestanbery/jarvis-logger \
      -w @lukestanbery/jarvis-auth \
      -w @lukestanbery/jarvis-server \
    # contracts' own `build` is skipped: it chains the two git-backed drift
    # guards (check-generated, check:endpoints) ahead of the real work. Run that
    # real work directly instead — generate the types and endpoint tables, bundle
    # and lint the spec, validate the AsyncAPI, then compile.
    && cd packages/contracts \
    && node scripts/generate-endpoint-tables.mjs \
    && npx openapi-typescript spec/openapi.yaml --output src/generated/openapi.ts \
    && npx redocly bundle spec/openapi.yaml --output spec/.bundle/openapi.yaml \
    && npx redocly lint spec/openapi.yaml \
    && npx asyncapi validate spec/asyncapi.yaml \
    && npx tsc

# ---------------------------------------------------------------------------
# Stage 2 — production-only dependency tree.
# ---------------------------------------------------------------------------
FROM node:24-bookworm AS prod

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/auth/package.json ./packages/auth/
COPY packages/cli/package.json ./packages/cli/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/logger/package.json ./packages/logger/
COPY packages/portal/package.json ./packages/portal/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/server/package.json ./packages/server/
COPY packages/voice/package.json ./packages/voice/
COPY packages/web/package.json ./packages/web/

# `--ignore-scripts` is required, not an optimization: the root `prepare` script
# runs husky, a devDependency that `--omit=dev` deliberately leaves out, so the
# install would exit 127 without it. `--omit=optional` keeps the optional TTS
# stack (kokoro-js + transformers.js/onnxruntime, #83) out of the runtime image:
# server TTS is config-gated and its provider reports itself unavailable when
# the module is missing, so the image boots and serves identically without it.
RUN npm ci --omit=dev --omit=optional --ignore-scripts \
    # better-sqlite3 is the one package whose native addon is genuinely needed at
    # runtime. Rebuilding it here (rather than copying from `deps`) keeps the
    # runtime image free of gcc/make/python.
    && npm rebuild better-sqlite3

# ---------------------------------------------------------------------------
# Stage 3 — runtime.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# Unprivileged runtime user. `-r` picks the next free system UID/GID so this
# cannot collide with a host UID baked into a base image.
RUN groupadd --system --gid 10001 jarvis \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/jarvis --create-home jarvis

WORKDIR /app

# Production dependency tree, including the npm workspace symlinks under
# node_modules/@lukestanbery that let the server resolve its siblings.
COPY --from=prod /app/node_modules ./node_modules
COPY --from=prod /app/package.json ./package.json

# Built packages. `contracts` needs more than `dist/`: the REST validator
# resolves `@lukestanbery/jarvis-contracts/package.json` at runtime and reads
# `spec/.bundle/openapi.yaml` from it, so the spec directory ships too.
COPY --from=deps /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=deps /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=deps /app/packages/logger/package.json ./packages/logger/package.json
COPY --from=deps /app/packages/logger/dist ./packages/logger/dist
COPY --from=deps /app/packages/auth/package.json ./packages/auth/package.json
COPY --from=deps /app/packages/auth/dist ./packages/auth/dist
COPY --from=deps /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=deps /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=deps /app/packages/contracts/spec ./packages/contracts/spec
COPY --from=deps /app/packages/server/package.json ./packages/server/package.json
COPY --from=deps /app/packages/server/dist ./packages/server/dist

# `homedir()` resolves here, so the app database (`~/.jarvis/jarvis.sqlite`) and
# LangGraph checkpoints (`~/.jarvis/checkpoints.sqlite`) land in the volume
# without needing JARVIS_DB_PATH / JARVIS_CHECKPOINT_PATH overrides.
ENV HOME=/home/jarvis \
    NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# `USER jarvis` comes after the volume so Docker creates the mountpoint with the
# right ownership.
USER jarvis
RUN mkdir -p /home/jarvis/.jarvis && chown -R jarvis:jarvis /home/jarvis

# Matches `getServerPort()`'s own default, so `docker run -p 54321:54321` works
# with no extra configuration.
EXPOSE 54321

# Machine health check; model-free, so it passes even with no LLM reachable.
# The agent graph builds a SQLite checkpointer at startup but never contacts the
# model, so this stays fast and dependency-free.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||54321)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

WORKDIR /app/packages/server
CMD ["node", "dist/index.js"]