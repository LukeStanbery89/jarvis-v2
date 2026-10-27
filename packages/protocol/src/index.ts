/**
 * Shared chat wire protocol for J.A.R.V.I.S. packages.
 *
 * The single home for the frames exchanged over the `/ws` WebSocket, and the
 * only implementation of their parsing and serialization. Consumers are
 * `@lukestanbery/jarvis-server` (`src/ws.ts`) and `@lukestanbery/jarvis-cli` (`src/client.ts`); see the
 * package README for the canonical protocol specification.
 */
import { plainText } from "./plainText";
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
    NotificationClass,
    NotificationFrame,
    NotificationPriority,
    ServerFrame,
    SessionActivityUpdate,
    SessionDeletedUpdate,
    SessionTitleUpdate,
    ToolSource,
} from "./types";
export type {
    JobRepeat,
    NextOccurrenceResult,
    RepeatFrequency,
    RepeatParseResult,
    Weekday,
    Zone,
} from "./repeat";
export type { GateCondition, GateParseResult, JobGate } from "./gate";
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
    MAX_PROMPT_LENGTH,
    MAX_SESSION_ID_LENGTH,
    MAX_SESSION_TITLE_LENGTH,
    MAX_TOKEN_LENGTH,
    MAX_TOOL_SOURCE_TITLE_LENGTH,
    MAX_TOOL_SOURCE_URL_LENGTH,
    MAX_TOOL_SOURCES,
    NOTIFICATION_CLASSES,
    NOTIFICATION_PRIORITIES,
    REVOKED_TOKEN_ERROR,
} from "./types";
export {
    describeRepeat,
    LOCAL_ZONE,
    MAX_REPEAT_INTERVAL,
    MAX_REPEAT_ORDINAL,
    MAX_REPEAT_STEPS,
    nextOccurrence,
    parseJobRepeat,
    repeatExhausted,
    REPEAT_FREQUENCIES,
    WEEKDAYS,
} from "./repeat";
export {
    GATE_CONDITIONS,
    gateKey,
    MAX_GATE_ARGS_LENGTH,
    MAX_GATE_TOOL_LENGTH,
    parseJobGate,
} from "./gate";
export { plainText };

export {
    MALFORMED_SERVER_FRAME,
    normalizeToolSources,
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
} from "./frame";
// A *type*, which no `isolatedModules` transform can re-export from a value
// block: `tsc` dropped it silently from the emitted JavaScript, so the mistake
// only showed itself when a consumer compiled the sources directly (#90 phase
// 8e, where the web's Vite alias to `src/` caught it).
export type { SerializeRequestOptions } from "./frame";
