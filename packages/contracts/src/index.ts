/**
 * J.A.R.V.I.S. API contract package.
 *
 * This package is the home of the machine-checkable contracts for both API
 * surfaces of `@lukestanbery/jarvis-server`:
 *
 * - `spec/openapi.yaml` — the OpenAPI 3.1 document for the REST API (`/api`
 *   management routes plus `GET /health`). It is the single source of truth
 *   for REST shapes; `npm run types` generates TypeScript for consumers from
 *   it and `npm run lint` / `npm run bundle` validate and bundle it.
 * - `spec/asyncapi.yaml` — the AsyncAPI 3.1 document for the `/ws` chat
 *   channel. It describes the frames of `@lukestanbery/jarvis-protocol`
 *   (`npm run validate` checks it); conformance tests keep the two in sync.
 *
 * The specs are hand-authored (contract-first) so they stay reviewable and
 * client-agnostic, mirroring the repo convention of a single source of truth
 * per concern (as `@lukestanbery/jarvis-protocol` is for wire frames).
 */

/**
 * Directory holding the hand-authored spec sources, relative to the package
 * root (`packages/contracts`).
 */
export const SPEC_DIR = "spec";

/** Path of the OpenAPI 3.1 (REST) document, relative to the package root. */
export const OPENAPI_SPEC = "spec/openapi.yaml";

/** Path of the AsyncAPI 3.1 (WebSocket) document, relative to the package root. */
export const ASYNCAPI_SPEC = "spec/asyncapi.yaml";

/** Path where `npm run types` writes the generated OpenAPI TypeScript types. */
export const GENERATED_TYPES = "src/generated/openapi.ts";
