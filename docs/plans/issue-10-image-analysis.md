# Plan — #10 Image analysis

Status: implemented — Phases 0-4 complete (see the work-items table for the PR)
Created: 2026-10-04
Last revised: after adversarial review (see "Review outcome")
Tracked by: [#10](https://github.com/LukeStanbery89/jarvis-v2/issues/10)

## Review outcome

An independent review agent audited this plan against the working tree and ran real
probes in `node_modules` (express 5.2.1, body-parser 2.3.0, `@langchain/core` 1.2.12,
`@langchain/langgraph` 1.4.16, express-openapi-validator 5.6.2, ws 8.21.3). Seven
blockers and ten risks were found. **Six of this plan's own claims were wrong.** All are
resolved below; superseded text has been removed rather than left to mislead.

| #      | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Resolution                                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | **BLOCKER.** `express.json` _is_ `bodyParser.json` (`express/lib/express.js:77`). The global `app.use(express.json())` at `app.ts:40` consumes every request body first, so a later route-local parser **never runs**. Every upload over ~75 KB of image bytes would be 413'd, making the 4 MB cap and the entire client downscale ladder dead on arrival.                                                                                                                     | Phase 2 mounts a per-route parser **before** the contract validator and keeps a 100 KB parser for the rest of `/api`.                                                                                                                                                                                                        |
| **B2** | **BLOCKER.** Deleting the global parser and moving it into the route breaks every `POST /api/*`: `express-openapi-validator` is mounted at `app.ts:44`, _ahead_ of the router, and its request validator reads `req.body` → `400 request must have required property 'body'`.                                                                                                                                                                                                  | Same fix as B1. Parser must be strictly before the validator.                                                                                                                                                                                                                                                                |
| **B3** | **BLOCKER.** `serializeRequest`'s positional `mode` has **six** call sites, not one: `web/src/ChatClient.ts:194`, `protocol/test/frame.test.ts:174/180/186`, `contracts/test/wsConformance.test.ts:246/253`, plus the signature documented at `protocol/README.md:43`. Deferring them to a later phase leaves the branch red. Worse, `wsConformance.test.ts` would go **green while asserting nothing** — the voice/text payloads degrade to plain prompts and still validate. | All six sites + the README migrate **inside the protocol commit**.                                                                                                                                                                                                                                                           |
| **B4** | **BLOCKER.** `ws.test.ts:12` does `vi.mock("../src/agent", () => ({ runAgent }))`, replacing the module wholesale — so `initAgentGraph` does not exist in that test graph. `http/app/contract` tests never call it either. A throwing `getAttachmentStore()` breaks every existing prompt test; a lazy one creates real temp dirs with no per-test isolation.                                                                                                                  | Store becomes a **factory** injected through the existing seams: `attachChatServer`'s `AttachmentOptions`, `createAuthRouter`, and `AppConfig`. No `initAgentGraph()` initialization.                                                                                                                                        |
| **B5** | **BLOCKER.** Putting `IMAGE_ANALYSIS_RULE` + the id list on the `HumanMessage` persists both into `checkpoints.sqlite` (the `MessagesAnnotation` reducer appends), contradicting this plan's own invariant — and on turn _N+1_ the model can call `analyzeImage` on a stale id from turn _N_, producing an `expired` error the user never caused.                                                                                                                              | Rule moves to the **system prompt** (`refreshedPrime` already swaps a changed prime in place). Only the id list stays on the `HumanMessage`, with a turn marker so consumed ids cannot be replayed.                                                                                                                          |
| **B6** | **BLOCKER.** `ensurePrivateDir` (`auth/src/fs.ts:28`) **only chmods directories the process created**; its doc deliberately skips pre-existing paths so pointed values cannot "lock out other users of shared paths like `/tmp`". This plan claimed 0700 in precisely the excluded case. A local user pre-creating `/tmp/jarvis-attachments` at 0777 defeats the control.                                                                                                      | Keep the chosen `os.tmpdir()` root, but **verify the mode ourselves** — `stat` the leaf and **fail loudly at startup** if group/other bits are set. Do not rely on `ensurePrivateDir` here. (`~/.jarvis/attachments` remains available via the env var.)                                                                     |
| **B7** | **BLOCKER.** Contracts drift guards (`check-generated`, `check:endpoints`) run _inside_ `contracts`' build, and the server resolves the gitignored `spec/.bundle/openapi.yaml` first — a stale bundle silently validates the old contract. Contracts build **before** server, so the server route is 404-dead until contracts land.                                                                                                                                            | Contracts move **before** the server phase. Regenerate `src/generated/openapi.ts` + `docs/endpoints-*.md` in the same commit. A conformance case that serializes a prompt _with_ attachments is mandatory there — the AsyncAPI `chatPrompt` schema is `additionalProperties: false`, so without it the spec drifts silently. |
| R1     | `setImmediate` has no rejection handling — a throwing sweep (e.g. `ENOENT` racing the OS reaper) becomes an **uncaughtException** that kills the process.                                                                                                                                                                                                                                                                                                                      | Wrap the sweep in `try/catch` + `logger.error`.                                                                                                                                                                                                                                                                              |
| R2     | `ByteLedger` release races: write-failure after reserve leaks the reservation; a double release silently stops the 200 MB bound from binding.                                                                                                                                                                                                                                                                                                                                  | One invariant: release is keyed on **registry-entry presence**, so it is idempotent; `get()` on an expired entry deletes-and-releases exactly once; the sweep tolerates `ENOENT`.                                                                                                                                            |
| R3     | No in-flight upload cap. ~15-20 MB per concurrent upload (base64 string + decoded Buffer + raw body held by `raw-body` + Ajv traversal). Auth bounds _who_, not _how many at once_.                                                                                                                                                                                                                                                                                            | Add a global in-flight semaphore (default 4) → 429.                                                                                                                                                                                                                                                                          |
| R4     | `Promise.race` for the VL timeout leaks the LM Studio socket.                                                                                                                                                                                                                                                                                                                                                                                                                  | **Verified good news:** `runtime.signal` is a real `AbortSignal`. Use `AbortSignal.any([runtime.signal, AbortSignal.timeout(ms)])`. The VL call is also cancelled free when the turn times out.                                                                                                                              |
| R5     | `DEFAULT_AGENT_MAX_TURNS = 10` — one looping prompt can drain the whole 10/min VL budget, and the 4B must narrate the refusals.                                                                                                                                                                                                                                                                                                                                                | Refusal message is explicitly model-facing ("do not retry; tell the user the quota is exhausted").                                                                                                                                                                                                                           |
| R6     | CSP for `/web` is `img-src 'self' data: https:` — **no `blob:`**, so a `URL.createObjectURL` preview breaks silently.                                                                                                                                                                                                                                                                                                                                                          | Preview uses `data:` (inside current policy) rather than widening CSP.                                                                                                                                                                                                                                                       |
| R7     | Usernames are mutable (`PATCH /api/users/{id}`); a rename orphans every attachment owned under the old name mid-TTL.                                                                                                                                                                                                                                                                                                                                                           | Key the owner tag on `user.id`.                                                                                                                                                                                                                                                                                              |
| R8     | The web client has **no CSRF token** — `api.ts:1-8` states it uses a device token with "no cookies, no CSRF", and `requireCsrf` is a documented no-op for bearer (`middleware.ts:178-182`).                                                                                                                                                                                                                                                                                    | Keep `requireCsrf` on the route for the portal / future cookie clients, but drop the client-side CSRF instruction and fix the Phase-5 test item.                                                                                                                                                                             |
| R9     | Unspecified: where the attachment check runs, and whether `mode: "voice"` accepts attachments.                                                                                                                                                                                                                                                                                                                                                                                 | Validate **before** `sessions.runTurn(...)`, or a bogus id still claims a session and creates an owned ledger row. Voice **is** compatible (VL output is plain text) — stated explicitly.                                                                                                                                    |
| R10    | `base64url(24 bytes)` is exactly 32 chars, so `MAX_ATTACHMENT_ID_LENGTH = 32` has **zero slack**. And the 413 body is indistinguishable from a parser overflow.                                                                                                                                                                                                                                                                                                                | Use 18 bytes (24 chars) so the 32 bound has slack. Rejection body becomes `{ error, code: "ATTACHMENT_TOO_LARGE", maxBytes }`.                                                                                                                                                                                               |
| N1     | **This plan was wrong:** "no `vitest.config.*` anywhere" — the check was broken by zsh `nomatch`. `packages/web/vitest.config.ts` and `packages/portal/vitest.config.ts` exist. Both set `include: ["src/**/*.test.ts"]`, so a **`.tsx` test would silently never run**.                                                                                                                                                                                                       | Corrected. Phase 4 notes the trap; web tests stay `.ts`.                                                                                                                                                                                                                                                                     |
| N2     | The `chatModel.ts` sole-importer invariant appears in **5-6** places, not 2.                                                                                                                                                                                                                                                                                                                                                                                                   | Stated positively across all of them.                                                                                                                                                                                                                                                                                        |
| N3     | Parser limit hardcoded as `"6mb"` desyncs from the config knob.                                                                                                                                                                                                                                                                                                                                                                                                                | Computed: `Math.ceil(maxBytes / 3) * 4 + envelope`.                                                                                                                                                                                                                                                                          |
| N5     | The `trust proxy` half of the #63 rationale was **overstated** — `ByteLedger` and `VlCallLimiter` key on resolved user identity, never `req.ip`.                                                                                                                                                                                                                                                                                                                               | Prerequisite narrowed to the CORS half, which is load-bearing.                                                                                                                                                                                                                                                               |
| N6     | Duplicate ids in one prompt double VL calls.                                                                                                                                                                                                                                                                                                                                                                                                                                   | Tool dedupes; ids may be reused across turns (that is why the TTL is 60 min).                                                                                                                                                                                                                                                |

### Riskiest assumption — now resolved

`configurable` **does** reach the tool callback's second argument, verified by running a
real `StateGraph` with this repo's exact `MessagesAnnotation`/`ToolNode`/`tool()`:

```
DIRECT runtime.configurable.attachmentOwner        -> "alice"   ✅
NESTED  runtime.config.configurable.attachmentOwner -> "alice"   ✅
runtime.signal -> AbortSignal                          ✅
state keys: ["messages"]
```

Mechanism: `tool_node.js:199-208` builds `runtime = { ...config, state, config, … }`,
then `tool.invoke(toolCall, runtime)`; `patchConfig` passes `configurable` through
untouched. **The `AsyncLocalStorage` fallback is unnecessary.**

Two consequences: type it via `ToolRuntime` from `@langchain/core/tools`, and note that
`configurable` arrives **polluted** (`__pregel_abort_signals`, `__pregel_task_id`,
`__pregel_scratchpad` — which holds the entire message array, `checkpoint_map`,
`checkpoint_ns`). Read the one key; never log or serialize the object.

Custom `configurable` keys are **not** persisted to the checkpoint (verified: metadata
keys are `source`, `step`, `parents`, `thread_id` only), which is what makes the B5 fix safe.

## Objective

Let a client attach an image to a chat prompt and have a dedicated vision-language model
(VL) analyze it, without changing the main chat model and without persisting image bytes.

## Prerequisite chain

```
docs chore (no issue)  →  #63  →  #10
```

**#63 must land first, for its CORS half.** After #28 the web client runs on a different
machine, so `POST /api/attachments` from a browser is cross-origin. (Its `trust proxy`
work is _not_ a #10 prerequisite — the new limiters key on resolved user identity, never
`req.ip`. It is still wanted on its own merits.)

## Verified findings

Measured or read from the code during planning. Items marked _(corrected)_ were wrong in
the first draft and are now fixed.

| Finding                                                                                                                                                              | Evidence                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ChatPrompt` is `{ prompt, sessionId, mode? }` — no image field                                                                                                      | `protocol/src/types.ts:94`                                             |
| The `"image"` capability token only means "I can render Markdown image links"                                                                                        | `server/src/agent.ts:99`                                               |
| The agent wraps every prompt as a plain-string `HumanMessage`                                                                                                        | `server/src/llm/agentGraph.ts:144`                                     |
| Default main model is `qwen/qwen3-4b-2507` — **text-only, 4B**                                                                                                       | `server/src/config.ts:15`                                              |
| `WebSocketServer` sets no `maxPayload` (ws default 100 MiB)                                                                                                          | `server/src/ws.ts:94`                                                  |
| The server has **no CORS anywhere**                                                                                                                                  | grep across `server/src`                                               |
| `app.ts:40` is a bare `express.json()` — 100 KB cap, and it runs before any route parser                                                                             | `server/src/app.ts:40`                                                 |
| `express.json` **is** `bodyParser.json` — no already-parsed short-circuit                                                                                            | `express/lib/express.js:77`                                            |
| The OpenAPI validator mounts ahead of `/api` **and** reads `req.body`, so the parser must precede it                                                                 | `server/src/http/contractValidation.ts`                                |
| The validator 404s an undocumented `/api` route                                                                                                                      | `openapi.metadata.js:49-53`                                            |
| No rate limiting on `/ws` at all                                                                                                                                     | no `RateLimiter` in `ws.ts`/`sessionManager.ts`/`agent.ts`             |
| `RateLimiter` increments on _every_ `admit()` and `recordSuccess()` deletes — unsuitable for quotas                                                                  | `server/src/http/rateLimit.ts:53-88`                                   |
| `chatModel.ts` is the only module knowing `@langchain/openai`, asserted in 5-6 places                                                                                | grep + doc sweep                                                       |
| `ensurePrivateDir` chmods **only self-created** dirs, by design                                                                                                      | `auth/src/fs.ts:28-37`                                                 |
| `ws.test.ts:12` replaces the whole `agent` module                                                                                                                    | `server/test/ws.test.ts`                                               |
| Web/portal vitest use `environment: "node"`, `include: ["src/**/*.test.ts"]`                                                                                         | _(corrected)_ `web/vitest.config.ts`                                   |
| No jsdom/happy-dom anywhere; Node has `Blob`/`File`/`FormData` but **not** `createImageBitmap`/`Image`/`OffscreenCanvas`/`FileReader`                                | Node 24 globals                                                        |
| auth owns a `user_version` migration chain (currently v5)                                                                                                            | `auth/src/store.ts:271`                                                |
| `qwen3.6-35b-a3b-splash` **is** a working VL model                                                                                                                   | live probe: answered "Blue" for a solid-blue 64×64 PNG via `image_url` |
| That model is a **reasoning** model — 142 of 146 completion tokens were `reasoning_tokens`; at `max_tokens: 64` it returned `content: ""`, `finish_reason: "length"` | live probe                                                             |
| LM Studio exposes no modality metadata, so vision support cannot be introspected                                                                                     | `/api/v0/models` returns empty `architecture`                          |

### Image-size measurements

Across 7,842 images on the local machine:

| bytes     | dims          | B/px     | file                                          |
| --------- | ------------- | -------- | --------------------------------------------- |
| 5,617,703 | 3840×2160     | 0.68     | 4K JPEG wallpaper                             |
| 4,215,742 | **1024×1024** | **4.02** | PNG mask (32-bit RGBA, near-zero compression) |
| 1,545,955 | 3840×1264     | 0.32     | JPEG gradient (JPEG's worst case)             |
| 1,432,790 | 1340×1012     | 1.06     | PNG atlas                                     |

```
p50: 4,420    p75: 15,163    p90: 56,299    p99: 647,069    max: 5,617,703
```

- PNG runs ~4 B/px, ~6× fatter than JPEG. **PNG, not JPEG, is what a tight cap collides with.**
- Bytes above ~2 MB buy nothing: VL encoders resize to a fixed pixel budget regardless of
  source resolution.
- Canvas cannot emit **lossless** WebP — `toBlob` exposes lossy only.

## Decisions

| Decision                 | Choice                                                                                                   | Rationale                                                                                                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image → VL model         | LangChain tool `analyzeImage({ attachmentId, query })` invoked by the primary model                      | The 4B main model cannot see the image, so it must delegate. Matches the issue's "call a specified VL model".                                                                                                                                                                                                         |
| Bytes → server           | REST `POST /api/attachments` → `{ attachmentId }`                                                        | Camera capture, face→user, and save/export all need an addressable id, not a prompt-scoped blob.                                                                                                                                                                                                                      |
| Upload format            | JSON base64                                                                                              | Avoids a multipart parser dependency.                                                                                                                                                                                                                                                                                 |
| Client scope             | Web manual upload only                                                                                   | Protocol and store stay client-agnostic.                                                                                                                                                                                                                                                                              |
| VL model config          | `LLM_VL_*` env vars, reuse `LLM_BASE_URL`                                                                | One inference server.                                                                                                                                                                                                                                                                                                 |
| VL unavailable           | Tool throws a loud, actionable error; conversation survives; startup warning if absent from `/v1/models` | Never silently answer about an unseen image; a transient hiccup does not kill the reply.                                                                                                                                                                                                                              |
| VL reasoning             | Discarded                                                                                                | Non-streaming call; only the final analysis reaches the client.                                                                                                                                                                                                                                                       |
| Attachment root          | `os.tmpdir()/jarvis-attachments`, **mode verified by us**                                                | Preserves the transient-by-design choice. `ensurePrivateDir` is not trusted here (B6); startup fails loudly if group/other bits are set.                                                                                                                                                                              |
| Lifetime                 | TTL 60 min, swept at startup and lazily on upload                                                        | Follow-up questions about the same photo need the bytes.                                                                                                                                                                                                                                                              |
| Per-user isolation       | In-memory owner tag on `user.id`, checked on tool use                                                    | `user.id` is stable; usernames are mutable. No DB migration.                                                                                                                                                                                                                                                          |
| Size cap                 | 4 MB decoded                                                                                             | Accepts an un-downscaled 4K JPEG so nothing hard-rejects until genuinely unusual.                                                                                                                                                                                                                                     |
| Per-user total           | 200 MB (50 live images)                                                                                  | Bounds temp-disk exhaustion, which a per-file cap cannot.                                                                                                                                                                                                                                                             |
| VL call rate             | 10/min per user                                                                                          | The only control that bounds compute abuse; the bytes are small and legal.                                                                                                                                                                                                                                            |
| In-flight uploads        | Global semaphore, default 4                                                                              | Bounds per-upload memory (R3).                                                                                                                                                                                                                                                                                        |
| Guest access             | **Image analysis requires auth**                                                                         | A guest socket would otherwise get an unbounded meter on 35B MoE inference.                                                                                                                                                                                                                                           |
| Upload validation        | Magic-byte sniff, not declared mime                                                                      | Never forward crafted non-image bytes to the ML runtime.                                                                                                                                                                                                                                                              |
| Client downscale trigger | Only when over budget or wrong type                                                                      | Small valid images upload byte-for-byte; no CPU or quality loss.                                                                                                                                                                                                                                                      |
| Downscale clamp          | 2048px longest edge, only when downscaling                                                               | Above what a VL encoder consumes; bounds dimension-scaled files.                                                                                                                                                                                                                                                      |
| Downscale output         | **PNG-as-PNG** for PNG sources (dimension ladder when over), JPEG q82 for photos                         | WebP ruled out by the Phase 0 probe — the runtime rejects it (HTTP 400) before the model ever sees it. Measured: text screenshots are ~0.03 MB at 2048px as PNG and even the pathological noise case fits at 1.60 MB, so the size objection that motivated WebP does not apply to text sources; glyphs stay lossless. |
| Server-side downscaling  | **Dropped**                                                                                              | Browser canvas covers the only shipping client. CLI/camera clients hard-reject above 4 MB — a known gap.                                                                                                                                                                                                              |
| `RateLimiter` reuse      | **Not reused**                                                                                           | `admit()` increments on every call and `recordSuccess()` deletes — a quota built on it would count successful uploads as failures.                                                                                                                                                                                    |
| Web upload auth          | Bearer device token; `requireCsrf` stays on the route for cookie clients                                 | The web client has no CSRF token by design.                                                                                                                                                                                                                                                                           |

## Architecture

```
 web composer                     server                        LM Studio
 ────────────                     ──────                        ─────────
 📎 / paste / drag-drop
   fits budget AND allowed type? ──yes──▶ upload byte-for-byte
         │no├── PNG source ─▶ clamp 2048px ─▶ PNG (dimension ladder if over)
         │  └── photo       ─▶ clamp 2048px ─▶ JPEG q82
         │                  dimension ladder (PNG) / quality ladder (JPEG) if still over
        │                       ▼
        │                  over 4 MB? ─▶ 413 { code:"ATTACHMENT_TOO_LARGE", maxBytes }
        ▼
 POST /api/attachments ──▶ [in-flight semaphore: max 4]
        │                   requireAuth (+ requireCsrf for cookie clients)
        │                   ← per-route parser, mounted BEFORE the validator
        │                   magic-byte sniff
        │                   per-user byte quota (ByteLedger)
         │  ◀────── 201 { attachmentId }   setImmediate(sweep)   ← fire-and-forget, try/caught
        │
 WS prompt { attachments:[id] }
        │   validate ids BEFORE sessions.runTurn (no phantom ledger rows)
        │   guest? ──▶ error frame (auth required)
        │   id exists + owner match? else error frame
        │   system prompt += IMAGE_ANALYSIS_RULE; HumanMessage += id list + turn marker
        │  ◀─ tool analyzeImage ─ VlCallLimiter ─▶ ChatOpenAI(VL_MODEL)
        │        AbortSignal.any([runtime.signal, timeout(VL_TIMEOUT)])
        │                                          reasoning discarded
        │  ◀─ chunks / done ◀──────── analysis text ─┘
```

**Invariants**

- Raw base64 never enters the LangGraph checkpoint and never reaches a log line.
- Only the VL analysis text is persisted in conversation history; the id list lives on the
  `HumanMessage` with a turn marker so consumed ids cannot be replayed (B5).
- `configurable` is read, never logged or serialized.
- No DB migration; no auth-package change.

## Config

| Var                                  | Default                            | Notes                                             |
| ------------------------------------ | ---------------------------------- | ------------------------------------------------- |
| `LLM_VL_MODEL`                       | `qwen3.6-35b-a3b-splash`           | from the issue                                    |
| `LLM_VL_MAX_TOKENS`                  | `1024`                             | probe burned 146 tokens on a one-word answer      |
| `LLM_VL_TIMEOUT_MS`                  | `60000`                            | under the 120 s turn timeout                      |
| `JARVIS_ATTACHMENT_DIR`              | `<os.tmpdir()>/jarvis-attachments` | mode verified at startup                          |
| `JARVIS_ATTACHMENT_TTL_MINUTES`      | `60`                               |                                                   |
| `JARVIS_ATTACHMENT_MAX_BYTES`        | `4194304`                          | parser limit computed as `ceil(n/3)*4 + envelope` |
| `JARVIS_ATTACHMENT_MAX_TOTAL_BYTES`  | `209715200`                        | per user, live bytes                              |
| `JARVIS_ATTACHMENT_VL_CALLS_PER_MIN` | `10`                               | per user                                          |
| `JARVIS_ATTACHMENT_MAX_INFLIGHT`     | `4`                                | global semaphore                                  |

## Phases

Each phase is one commit on the issue's feature branch. One PR per issue, merged with a
**merge commit** so individual phase commits are preserved.

### Docs chore — branch `chore/rate-limit-docs`

| File                            | Change                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/README.md`     | New `## Rate limiting` section: a table of every limiter (scope, keys, thresholds, env vars, error), `admit()`-before-expensive-work and `recordSuccess()`-clears semantics, the in-memory/single-instance posture, the `trust proxy` caveat, and an explicit **"Not rate limited"** subsection (`/ws` chat path). Replace the existing login narrative (lines 183-191) with a pointer. |
| `packages/server/src/README.md` | Add the missing `http/rateLimit.ts` row to the File map table; extend its tree comment.                                                                                                                                                                                                                                                                                                 |
| `README.md`                     | Operator note under Configuration: login/bootstrap throttled, chat path not; link to the server README.                                                                                                                                                                                                                                                                                 |
| `AGENTS.md`                     | New Conventions bullet: read a module's `README.md` before grepping its source; fix it in the same change if wrong or silent.                                                                                                                                                                                                                                                           |

### Phase 0 — WebP capability probe (a gate, no commit)

**RESULT (2026-10-04, LM Studio `qwen3.6-35b-a3b-splash`): WebP is NOT supported.**

Probed with a sharp-validated 88-byte solid-color WebP (RIFF/WEBP verified, decodes in
libvip) against the OpenAI-compatible `/v1/chat/completions` endpoint:

| Input                     | Result                                                     |
| ------------------------- | ---------------------------------------------------------- |
| PNG (identical code path) | 200, model answers "Blue" — vision path works              |
| JPEG (control)            | 200, model answers "Blue" — not a PNG-only runtime         |
| WebP                      | **HTTP 400** `'url' field must be a base64 encoded image.` |

The 400 is the runtime's ingest layer refusing the format (the same construction that
succeeds for PNG/JPEG), so `image_url` WebP cannot reach the model at all. Measured
with a second control so "the file was broken" is eliminated: the same bytes decode
fine in sharp, and JPEG from the same generator is accepted.

**Fallback per this section's gate: PNG for text sources, or JPEG q92 — see the
"Downscale output" decision row for the resolved choice.**

Empirical size data for that choice (2048px, dense synthetic terminal screenshot):

| Encoding      | Text content | Noise-injected (pathological) |
| ------------- | ------------ | ----------------------------- |
| PNG, lossless | 0.03 MB      | 1.60 MB                       |
| JPEG q92      | —            | 0.14 MB                       |

Genuine text/UI screenshots compress to tens of KB as PNG; the plan's earlier "2-4 MB"
fear applies to photos stored as PNG, not text. Even the pathological noise case fits
the 4 MB cap.

### Phase 1a — protocol

`ChatPrompt.attachments?: string[]`, `MAX_ATTACHMENTS = 4`, `MAX_ATTACHMENT_ID_LENGTH = 32`
(18-byte ids = 24 chars, so the bound has slack), validated in `validateChatPrompt`.
`serializeRequest`'s positional `mode` becomes an options object.

**In this same commit:** all six call sites (`web/src/ChatClient.ts:194`,
`protocol/test/frame.test.ts:174/180/186`, `contracts/test/wsConformance.test.ts:246/253`)
and the signature at `protocol/README.md:43`. Verify the conformance suite still asserts
something — B3 notes it would otherwise go green while testing nothing.

```ts
export function serializeRequest(
    prompt: string,
    sessionId: string,
    options: { mode?: ChatMode; attachments?: string[] } = {},
): string {
    return JSON.stringify({
        prompt,
        sessionId,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.attachments?.length
            ? { attachments: options.attachments }
            : {}),
    });
}
```

### Phase 1b — contracts (**must precede the server route**)

OpenAPI `POST /api/attachments` (new `Attachments` tag; Redocly default `recommended`
ruleset — `operation-operationId` is an **error**) + AsyncAPI `attachments` on `chatPrompt`

- a conformance case that serializes a prompt **with** attachments. Then `npm run types`
  and `npm run docs:endpoints`, committing `spec/openapi.yaml`, `spec/asyncapi.yaml`,
  `src/generated/openapi.ts`, and `docs/endpoints-*.md` together.

Base64 field is a bare `type: string` with `maxLength` and **no `pattern`** — a regex over
5.6 M chars is real CPU on every request, and Ajv's first message is handed to the client.

### Phase 2 — server

| File                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app.ts`                    | **First:** mount the per-route parser before `mountContractValidator`, keeping the 100 KB parser for the rest of `/api` (B1/B2). `src/README.md`'s `app.ts` row updates too.                                                                                                                                                                                                                                          |
| `src/attachments/store.ts`      | New **factory** `createAttachmentStore(config)`. 18-byte ids; dir mode **verified** with `stat`, loud failure if group/other-accessible (B6); `get` throws typed `unknown \| expired \| foreign`; `put` sniffs magic bytes then reserves quota, releasing on write failure; idempotent release keyed on registry-entry presence (R2); sweep tolerates `ENOENT`. Injected, never initialized in `initAgentGraph` (B4). |
| `src/attachments/limiters.ts`   | New. `VlCallLimiter` (fixed window, model-facing refusal text), `ByteLedger`, and an in-flight semaphore (R3). Not in `http/rateLimit.ts`.                                                                                                                                                                                                                                                                            |
| `src/llm/visionModel.ts`        | New. The only module constructing the VL `ChatOpenAI`. Non-streaming, `maxTokens`, `AbortSignal.any([runtime.signal, AbortSignal.timeout(ms)])` (R4), reasoning discarded.                                                                                                                                                                                                                                            |
| `src/llm/tools/analyzeImage.ts` | New. `{ attachmentId, query }`; owner from `runtime.configurable.attachmentOwner` via `ToolRuntime` (**verified** — no ALS fallback); dedupes ids; checks the VL limiter.                                                                                                                                                                                                                                             |
| `src/agent.ts`                  | `RunAgentOptions` gains `attachmentIds` + `attachmentOwner`; `IMAGE_ANALYSIS_RULE` appended to the **system prompt**, not the human turn (B5); id list + turn marker on the `HumanMessage`.                                                                                                                                                                                                                           |
| `src/http/attachmentRoutes.ts`  | New. `POST /api/attachments` behind `requireAuth` + `requireCsrf`; rejection body `{ error, code: "ATTACHMENT_TOO_LARGE", maxBytes }` (R10).                                                                                                                                                                                                                                                                          |
| `src/ws.ts`                     | Thread `attachments` through; validate **before** `sessions.runTurn` (R9); reject on a guest socket; fail fast on unknown/expired/foreign id. Voice mode is compatible and documented as such.                                                                                                                                                                                                                        |

### Phase 3 — web client

| File                       | Change                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api.ts`               | `uploadAttachment()`, bearer auth, no CSRF token (R8).                                                                                                                                       |
| `src/ChatClient.ts`        | `send(text, sessionId, { attachments })`.                                                                                                                                                    |
| `src/views/Chat.tsx`       | 📎 button + paste + drag/drop + removable preview chip. Preview uses `data:`, not `blob:` (R6).                                                                                              |
| `src/downscale/policy.ts`  | **New, pure.** Edge clamp, format selection, quality ladder, budget loop — fully unit-tested in bare Node.                                                                                   |
| `src/downscale/browser.ts` | **New, thin adapter.** `createImageBitmap` → canvas → `toBlob`, `imageOrientation: "from-image"`. Browser-verified only. `noUnusedLocals` means deliberate stubs need `_`-prefixed bindings. |
| `src/threads.ts`           | Transcript keeps `attachmentIds` only; reload shows a muted "image not retained".                                                                                                            |

Retry once with a stricter budget on a 413 carrying `code: "ATTACHMENT_TOO_LARGE"`.

**Trap:** `web/vitest.config.ts` has `include: ["src/**/*.test.ts"]` — a `.tsx` test would
silently never run. Keep web tests `.ts`.

### Phase 4 — tests and docs

Tests: protocol back-compat + a max-length id round-trip; store expiry/sweep/owner-isolation
on `user.id`/mode-verification/magic-bytes/idempotent release; limiters incl. window
rollover, byte release, semaphore saturation; tool query pass-through, all three error
kinds, limiter refusal, id dedupe; mocked VL asserting reasoning discarded, no base64 in
any log line, and abort propagation; route auth, CSRF-for-cookie-clients, cap, mime, 413
shape; ws guest-rejection, unknown-id **before** session claim, voice compatibility;
downscale policy ladder (pure); web upload-to-send payload.

Docs: state the `chatModel.ts`/`visionModel.ts` invariant **positively across all 5-6
places it appears**; update the endpoints tables; add the new limiter rows to the rate-limiting
section from the docs chore.

## Security posture

| Control                           | Where                                                          | Value                                       |
| --------------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| Over-cap upload rejected          | per-route parser limit, aborts mid-stream                      | computed from `JARVIS_ATTACHMENT_MAX_BYTES` |
| In-flight uploads                 | global semaphore                                               | 4                                           |
| Magic-byte sniff vs declared mime | `put()`, before any write                                      | jpeg/png/webp only                          |
| Auth required                     | `requireAuth`; `ws.ts` rejects attachments from a guest socket | no anonymous inference                      |
| Per-user total bytes              | `ByteLedger`, idempotent release                               | 200 MB                                      |
| Per-user VL call rate             | `VlCallLimiter`                                                | 10 / min                                    |
| Owner binding                     | registry `user.id`, checked on tool use                        | —                                           |
| TTL                               | startup + lazy sweep, `try/catch`ed                            | 60 min                                      |
| Directory mode                    | verified at startup, **fails loudly**                          | 0700                                        |

### Why the byte cap alone is not enough

| Vector                                                                      | What a byte cap does                        | Severity                             |
| --------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------ |
| VL inference abuse — a loop of image prompts forces repeated 35B MoE passes | **Nothing**; the bytes were small and legal | **Highest** — compute, not bandwidth |
| Memory — ~15-20 MB per concurrent upload                                    | Only with the in-flight semaphore           | Low with the cap, High without       |
| Temp-disk exhaustion — 4 MB × N inside the TTL                              | Per-file only                               | Medium                               |
| Hostile image bytes reaching the ML runtime                                 | Only if we sniff magic bytes                | Medium                               |

## Risks

| Risk                                 | Mitigation                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| WebP support in the VL runtime       | **Resolved by the Phase 0 probe:** unsupported (HTTP 400); PNG-as-PNG chosen per decision row |
| The 4B may skip the tool call        | `IMAGE_ANALYSIS_RULE`; log invocation rate. Fallback is server-side pre-analysis.             |
| 35B MoE on CPU may exceed 60 s       | AbortSignal timeout; 120 s turn timeout is the outer bound                                    |
| HEIC/PNG re-encode is lossy          | Fine for photos; may cost legibility on text-dense images                                     |
| Non-browser clients cannot downscale | Known gap — hard rejection above 4 MB                                                         |

## Follow-ups

- Guest `/ws` frequency rate limiting — filed separately, not implemented here.
- Server-side downscaling for non-browser clients — **not filed**; revisit when such a client exists.
- Camera capture pull, face→user identity, persist/export attachments — all roadmap.

## Work items

| Order | Work item                         | Branch                               | PR                                     |
| ----- | --------------------------------- | ------------------------------------ | -------------------------------------- |
| 1     | Docs chore                        | `chore/rate-limit-docs`              | **Done** — merged as #67 (found #66)   |
| 2     | #63 CORS / SameSite / trust proxy | `feat/issue-63-cross-origin-support` | **Done** — merged as #68               |
| 3     | #10 image analysis                | `feat/issue-10-image-analysis`       | closes #10 — Phases 0-4 on this branch |

Merge with `--merge` (not squash) so phase commits are preserved.

Filed along the way, not part of #10's PR: #65 (`/ws` frequency limiting),
#66 (`maxIpFailures` dead config). Both stayed out of the shipped PRs per one-PR-per-issue.
