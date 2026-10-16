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
    AudioEndFrame,
    AudioFormat,
    AudioStartFrame,
    ChatMode,
    ChatPrompt,
    ClientCancelFrame,
    ClientCapability,
    ClientFrame,
    ClientHello,
    ClientLocationFrame,
    NotificationFrame,
    NotificationPriority,
    ServerFrame,
} from "./types";
export {
    CHAT_MODES,
    CLIENT_CAPABILITIES,
    MAX_ATTACHMENTS,
    MAX_ATTACHMENT_ID_LENGTH,
    MAX_CAPABILITIES,
    MAX_CAPABILITY_LENGTH,
    MAX_LOCATION_LABEL_LENGTH,
    MAX_NOTIFICATION_ANSWER_LENGTH,
    MAX_NOTIFICATION_BODY_LENGTH,
    MAX_NOTIFICATION_ID_LENGTH,
    MAX_NOTIFICATION_KIND_LENGTH,
    MAX_NOTIFICATION_TITLE_LENGTH,
    MAX_SESSION_ID_LENGTH,
    MAX_TOKEN_LENGTH,
    NOTIFICATION_PRIORITIES,
    REVOKED_TOKEN_ERROR,
} from "./types";
export {
    MALFORMED_SERVER_FRAME,
    parseClientMessage,
    parseFrame,
    parseRequest,
    pcmToS16le,
    s16leToPcm,
    serializeAuth,
    serializeCancel,
    serializeFrame,
    serializeHello,
    serializeLocation,
    serializeRequest,
    SerializeRequestOptions,
} from "./frame";
