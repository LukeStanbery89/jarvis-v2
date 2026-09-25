# @lukestanbery/jarvis-contracts

Machine-checkable API contracts for J.A.R.V.I.S.. This package is the home of
the **contract-first** specifications that describe both API surfaces of
`@lukestanbery/jarvis-server`, plus the tooling that validates them and turns
them into TypeScript: the REST API (`/api` management routes + `GET /health`)
and the WebSocket chat endpoint (`/ws`).

## Specs

| File                 | Concern                                                          | Tooling        |
| -------------------- | ---------------------------------------------------------------- | -------------- |
| `spec/openapi.yaml`  | OpenAPI 3.1 document for the REST API                            | typegen + lint |
| `spec/asyncapi.yaml` | AsyncAPI 3.1 document for the `/ws` chat channel                 | validate       |
| `src/generated/`     | TypeScript types generated from `openapi.yaml` (`npm run types`) | typegen        |

The `/ws` frame shapes mirror `@lukestanbery/jarvis-protocol` (the TypeScript
single source of truth for the wire format); the two must evolve in lockstep.
Conformance tests enforce that automatically: they parse this spec and
validate representative real frames against each message payload.

## REST spec inventory (`spec/openapi.yaml`)

22 operations covering `GET /health` and the 21 `/api` management routes,
mirroring the handlers in `packages/server/src/http/authRoutes.ts`:

| Tag              | Operations (operationId)                                                               |
| ---------------- | -------------------------------------------------------------------------------------- |
| `Health`         | `GET /health` (`healthCheck`)                                                          |
| `Bootstrap`      | `POST /api/bootstrap` (`bootstrap`)                                                    |
| `Authentication` | `POST /api/auth/login` (`authLogin`), `POST /api/session` (`sessionLogin`)             |
| `Session`        | `GET`/`DELETE /api/session` (`sessionGet`/`sessionLogout`)                             |
| `Account`        | `GET /api/me` (`meGet`)                                                                |
| `Devices`        | `POST /api/devices`, `PATCH`/`DELETE /api/devices/{id}`, `GET /api/users/{id}/devices` |
| `Users`          | `GET`/`POST /api/users`, `PATCH /api/users/{id}`                                       |
| `Preferences`    | `GET`/`PUT`/`DELETE /api/prefs`, `GET`/`PUT`/`DELETE /api/users/{id}/prefs`            |
| `ChatSessions`   | `GET /api/sessions`, `DELETE /api/sessions/{threadId}`                                 |

Key shapes in `components.schemas`: `User`, `Device` (nullable `lastSeenAt`),
`IssuedDevice` (one-time `token`), `AuthResult` (shared by bootstrap + device
login), `Session` (optional `csrfToken` for cookie vs bearer), `SessionLogin`,
`MeResult`, `SessionSummary` (nullable `userId`), `Prefs`, `Error`. Auth is a
device-token bearer OR the `jarvis_session` cookie (`bearerToken` and `session`
security schemes), with optional `x-csrf-token` on cookie-authenticated state
changes and a required `x-bootstrap-token` on bootstrap. Error responses reuse
the server's `AUTH_ERROR_STATUS` map — **no 422** in this API.

## Scripts

| Script                    | Description                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run build`           | Check generated → bundle → lint → validate → compile `src/` to `dist/`                     |
| `npm run check-generated` | Regenerate types and fail the build if diffing the committed file (`git diff --exit-code`) |
| `npm run types`           | Regenerate `src/generated/openapi.ts` from `spec/openapi.yaml`                             |
| `npm run bundle`          | Bundle `openapi.yaml` to `spec/.bundle/openapi.yaml` (single-file)                         |
| `npm run lint`            | Redocly lint `spec/openapi.yaml`                                                           |
| `npm run validate`        | Validate `spec/asyncapi.yaml` (AsyncAPI CLI)                                               |
| `npm run typecheck`       | Type-check src and tests (no emit)                                                         |
| `npm test`                | Run the Smoke tests (Vitest)                                                               |

## Editing a spec

1. Edit the YAML under `spec/`.
2. Run `npm run lint` / `npm run validate` until clean.
3. If the OpenAPI shapes changed, run `npm run types` and commit the
   regenerated `src/generated/openapi.ts` alongside the spec edit. The build
   gates on this: `check-generated` regenerates the file and fails when it
   differs from the committed version, so a stale typegen can never sail
   through CI or the pre-push hook.
4. Run the root `npm run check` (the workspace `build` chain runs the checked
   typegen, bundle, lint, and validate in dependency order).

## Notes for maintainers

- The package is deliberately **spec + tooling only**: no runtime
  dependencies, no application code. Specs are hand-authored so they stay the
  reviewable contract and double as the API reference for non-TypeScript
  clients.
- Dependents that want the generated REST types import them **type-only** from
  this package's compiled `dist` output (same convention as
  `@lukestanbery/jarvis-protocol` and `@lukestanbery/jarvis-logger`), so edit +
  regenerate + rebuild (`npm run check`) before type-checking dependents.
- The server is a runtime consumer too: it points `express-openapi-validator`
  at the Redocly bundle (`spec/.bundle/openapi.yaml`, or the source YAML when
  the bundle hasn't been built) to validate REST requests always and responses
  under `JARVIS_API_CONTRACT=verify`. Keep the spec truthful — a spec that
  overstates request requirements (e.g. hard-requiring an auth header that is
  really a policy outcome) will 400 requests before the router can answer.

## WS spec inventory (`spec/asyncapi.yaml`)

One channel (`/ws`), two operations, eight messages — one per frame, mirroring
`@lukestanbery/jarvis-protocol`'s types:

| Operation            | Direction     | Messages                                                         |
| -------------------- | ------------- | ---------------------------------------------------------------- |
| `sendClientFrame`    | client→server | `authHandshake` (optional first frame), `chatPrompt`             |
| `receiveServerFrame` | server→client | `authResult`, `chunk`, `toolCall`, `toolResult`, `done`, `error` |

Payloads are strict (`additionalProperties: false`) and encode the protocol's
bounds: non-empty-after-trim strings (`pattern: \S`) and the ≤128-char
`sessionId`/`token` caps. The server object documents the default cleartext
`ws://localhost:54321/ws` (TLS deployments serve `wss` at the same path).
