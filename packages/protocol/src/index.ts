/**
 * Shared chat wire protocol for J.A.R.V.I.S. packages.
 *
 * The single home for the frames exchanged over the `/ws` WebSocket, and the
 * only implementation of their parsing and serialization. Consumers are
 * `@lukestanbery/jarvis-server` (`src/ws.ts`) and `@lukestanbery/jarvis-cli` (`src/client.ts`); see the
 * package README for the canonical protocol specification.
 */
export type { ChatPrompt, ServerFrame } from "./types";
export { MAX_SESSION_ID_LENGTH } from "./types";
export {
    parseFrame,
    parseRequest,
    serializeFrame,
    serializeRequest,
} from "./frame";
