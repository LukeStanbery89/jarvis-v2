/**
 * Shared chat wire protocol for J.A.R.V.I.S. packages.
 *
 * The single home for the frames exchanged over the `/ws` WebSocket, and the
 * only implementation of their parsing and serialization. Consumers are
 * `@lukestanbery/jarvis-server` (`src/ws.ts`) and `@lukestanbery/jarvis-cli` (`src/client.ts`); see the
 * package README for the canonical protocol specification.
 */
export type {
    AuthRequest,
    AuthResult,
    AuthResultFrame,
    ChatMode,
    ChatPrompt,
    ClientCapability,
    ClientFrame,
    ClientHello,
    ClientLocationFrame,
    ServerFrame,
} from "./types";
export {
    MAX_ATTACHMENTS,
    MAX_ATTACHMENT_ID_LENGTH,
    MAX_CAPABILITIES,
    MAX_CAPABILITY_LENGTH,
    MAX_LOCATION_LABEL_LENGTH,
    MAX_SESSION_ID_LENGTH,
    MAX_TOKEN_LENGTH,
} from "./types";
export {
    parseClientMessage,
    parseFrame,
    parseRequest,
    serializeAuth,
    serializeFrame,
    serializeHello,
    serializeLocation,
    serializeRequest,
    SerializeRequestOptions,
} from "./frame";
