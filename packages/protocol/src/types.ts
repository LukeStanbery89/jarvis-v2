/**
 * Shared chat wire-protocol types for J.A.R.V.I.S. packages.
 *
 * This is the **single source of truth** for the frames exchanged over the
 * `/ws` WebSocket between `@lukestanbery/jarvis-cli` and `@lukestanbery/jarvis-server`. Keeping the
 * shapes here (rather than duplicated in each package) guarantees a frame
 * rename or shape change surfaces as a compile error everywhere a frame is
 * handled, instead of a silent runtime mismatch.
 */

/**
 * A frame the server sends to chat clients over `/ws`.
 *
 * Frames are JSON object frames, key-discriminated: exactly one of
 * `chunk` / `tool` / `toolResult` / `done` / `error` / `authResult` /
 * `audioStart` / `audioEnd` / `notification` is present. Binary WebSocket
 * messages (raw little-endian s16le PCM chunks, #83) are not JSON and never
 * pass through frame parsing — clients branch on the message type before
 * parsing.
 *
 * Every frame but {@link NotificationFrame} belongs to a turn: a client may
 * assume the frames between a prompt and its `done` describe that turn. A
 * `notification` is the one server frame that arrives **outside** a turn
 * (#139) — a client must accept it whenever the socket is ready, not only
 * while a prompt is streaming.
 */
export type ServerFrame =
    | { chunk: string }
    | { tool: { name: string; args?: unknown } }
    | { toolResult: { name: string; output?: unknown } }
    | { done: true }
    | { error: string }
    | AuthResultFrame
    | AudioStartFrame
    | AudioEndFrame
    | NotificationFrame;

/** Payload of an `authResult` frame: the account a socket is now bound to. */
export interface AuthResult {
    /** The authenticated user's username. */
    user: string;
    /** The name of the device the client authenticated with. */
    device: string;
}

/** Server acknowledgment of a successful auth handshake (`{ "authResult": … }`). */
export interface AuthResultFrame {
    authResult: AuthResult;
}

/**
 * The wire format of the binary PCM chunks an `audioStart`…`audioEnd` span
 * carries (#83). Little-endian signed 16-bit — universally decodable, four
 * bytes smaller per frame than float32, and the format Kokoro's output
 * converts to losslessly.
 */
export type AudioFormat = "pcm_s16le";

/**
 * Opens one turn's spoken-audio span (`{ "audioStart": … }`, #83): the
 * binary PCM messages that follow, until the matching `audioEnd`, are mono
 * samples in the declared format/rate. Text frames (`chunk`/`tool`/
 * `toolResult`) interleave freely — audio is a presentation layer.
 */
export interface AudioStartFrame {
    audioStart: {
        /**
         * The turn generation this audio belongs to — the server's
         * per-socket turn counter. Clients that cancel/replace turns use it
         * to discard stale audio (barge-in, #83 P6); for now it is echoed
         * information.
         */
        generationId: number;
        /** The PCM format of the binary messages that follow. */
        format: AudioFormat;
        /** Sample rate of the PCM, in Hz (Kokoro: 24000). */
        sampleRate: number;
        /** Channel count — always mono today. */
        channels: 1;
    };
}

/** Closes the turn's spoken-audio span (`{ "audioEnd": … }`, #83). */
export interface AudioEndFrame {
    audioEnd: {
        /** The turn generation this audio belongs to (matches `audioStart`). */
        generationId: number;
    };
}

/**
 * The urgency tokens the protocol recognizes, in ascending order.
 *
 * The {@link NotificationPriority} union derives from this tuple, so the
 * protocol, the server's routing policy, and the client's presentation cannot
 * drift on what the levels are.
 */
export const NOTIFICATION_PRIORITIES = [
    "low",
    "normal",
    "high",
    "urgent",
] as const;

/**
 * How much a notification is allowed to disturb the user.
 *
 * The server's routing policy reads this (#139 phase 1): `low` and `normal`
 * respect quiet hours and coalesce, `high` and `urgent` bypass them. This is
 * the one field a client should use to decide between a silent badge and
 * something that speaks.
 */
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

/**
 * The payload of a `notification` frame: something JARVIS wants to tell the
 * user that no one asked for (#139).
 *
 * Deliberately a *payload* and not a whole record: the durable record lives
 * in the server's store and is read back over REST, so this frame carries only
 * what a client needs to render an interruption — identity (so the client can
 * match it against its fetched list and dedupe a redelivery), the text, how
 * loud it may be, and whether it wants an answer. Delivery is best-effort: a
 * client that was offline sees the notification in its next `GET
 * /api/notifications` instead.
 */
export interface NotificationFrame {
    notification: {
        /** Stable id, matching the record's `GET /api/notifications` entry. */
        id: string;
        /**
         * Producer-defined category ("job.finished", "reminder", …), so a
         * client can pick an icon and a policy without the protocol growing a
         * token per feature. Free-form but bounded ({@link MAX_NOTIFICATION_KIND_LENGTH}).
         */
        kind: string;
        priority: NotificationPriority;
        /** One-line headline, already written for display. */
        title: string;
        /** Optional detail; absent when the headline says everything. */
        body?: string;
        /** When the notification was created, ISO-8601 UTC. */
        createdAt: string;
        /**
         * Whether this notification is a question: the user's reply is
         * expected, and answering is what retires it (rather than reading or
         * dismissing). The reply path is the producer's — see #94.
         */
        requiresAnswer?: boolean;
    };
}

/**
 * Longest notification `id` the protocol carries.
 *
 * Server ids are 18 random bytes (24 base64url characters); the bound leaves
 * room for a future id scheme without re-opening the protocol.
 */
export const MAX_NOTIFICATION_ID_LENGTH = 64;

/** Longest notification `kind` token, bounding a display/route field. */
export const MAX_NOTIFICATION_KIND_LENGTH = 64;

/** Longest notification `title` — a headline, not a paragraph. */
export const MAX_NOTIFICATION_TITLE_LENGTH = 200;

/** Longest notification `body` — enough for a sentence or three. */
export const MAX_NOTIFICATION_BODY_LENGTH = 2000;

/**
 * Longest `answer` a client may send back for an answerable notification.
 *
 * Generous for a dictated sentence (the intended path is voice, #94) while
 * bounding what a caller can park in the store.
 */
export const MAX_NOTIFICATION_ANSWER_LENGTH = 2000;

/**
 * A frame a chat client sends to the server over `/ws`.
 *
 * Exactly one of these shapes arrives per message: the first-frame `auth`
 * handshake (to bind the socket to an account), the first-frame `hello`
 * announcement (to declare what the client can render), a chat prompt, a
 * `location` report (to update the device's whereabouts for location-aware
 * tools), or a `cancel` (#84 P6) dropping the socket's in-flight turn.
 */
export type ClientFrame =
    | AuthRequest
    | ClientHello
    | ChatPrompt
    | ClientLocationFrame
    | ClientCancelFrame;

/**
 * The auth handshake: the client's first frame, presenting a stored device
 * token to bind the socket to a user account.
 */
export interface AuthRequest {
    type: "auth";
    token: string;
}

/**
 * The error text the server sends when a mid-session request is rejected
 * because the socket's device token was revoked (#107 P1).
 *
 * Clients match this exact string to distinguish "your session was revoked,
 * sign in again" from a generic turn error and react by re-authenticating; the
 * server, the CLI, and the web client all import this constant so the wire
 * text cannot drift between the sender and its two matchers.
 */
export const REVOKED_TOKEN_ERROR =
    "device token revoked; reconnect to re-authenticate";

/**
 * The capability tokens the protocol recognizes, in wire order.
 *
 * The {@link ClientCapability} union is derived from this tuple — there is no
 * second list to keep in sync — so removing a token here is a compile error at
 * every exhaustive consumer (the parser's membership set, `Record<
 * ClientCapability, …>` maps, switches), and adding one cannot be forgotten by
 * the parser.
 */
export const CLIENT_CAPABILITIES = [
    "markdown",
    "html",
    "image",
    "link",
    "audio",
] as const;

/**
 * What one chat client is capable of rendering in the server's response.
 *
 * Tokens are coarse render guarantees the client absorbs as plain text; the
 * server conditions its output (and eventually its content frames) on the
 * capabilities an announcing client declared. Unknown tokens are rejected at
 * parse time so the shared contract stays tight.
 *
 * `audio` (#83) declares the client can play the turn's spoken response:
 * voice-mode prompts from such a socket are also synthesized server-side
 * and delivered as an `audioStart` … binary PCM … `audioEnd` span. Text
 * rendering is unaffected — a client may hold `audio` and any other tokens
 * at once.
 */
export type ClientCapability = (typeof CLIENT_CAPABILITIES)[number];

/**
 * The capability announcement: a client's optional first frame declaring, in
 * `capabilities`, which of the {@link ClientCapability} tokens it can render.
 * The server logs and stores the declaration for the socket's lifetime and
 * conditions the agent's system prompt on it. An empty array ("renders plain
 * text only") is valid; a second `hello` on the same socket is rejected.
 */
export interface ClientHello {
    type: "hello";
    capabilities: ClientCapability[];
}

/**
 * The chat-mode tokens the protocol recognizes, in wire order.
 *
 * The {@link ChatMode} union derives from this tuple; see
 * {@link CLIENT_CAPABILITIES} for why the derivation (rather than a parallel
 * hand-maintained union) is the point.
 */
export const CHAT_MODES = ["text", "voice"] as const;

/**
 * The chat mode a prompt runs under.
 *
 * Structurally mirrors the session ledger's `SessionKind` ("text" | "voice")
 * in `@lukestanbery/jarvis-auth` — the server passes the wire value straight
 * through as the ledger kind without importing this package. `"text"` chats
 * are answered using the client's declared render capabilities; `"voice"`
 * chats always yield plain conversational text.
 */
export type ChatMode = (typeof CHAT_MODES)[number];

/**
 * A chat request from a client: the free-text `prompt` and the `sessionId`
 * naming the LangGraph conversation thread it continues, plus the optional
 * `mode` the chat runs under (absent means `"text"`).
 */
export interface ChatPrompt {
    prompt: string;
    sessionId: string;
    /**
     * The chat mode for this prompt; `"text"` when omitted. `"voice"` prompts
     * are answered with plain conversational text regardless of the client's
     * declared render capabilities. The server records the mode as the
     * session's `kind` when it first claims the thread.
     */
    mode?: ChatMode;
    /**
     * Ids of previously uploaded attachments this prompt references
     * (`POST /api/attachments` returns them), when the prompt is about
     * images. Absent (or empty) for plain text prompts. Ids are opaque to the
     * protocol — the server resolves them against its attachment store and
     * rejects ids that do not exist or belong to another user.
     */
    attachments?: string[];
}

/**
 * The device-location report: a client telling the server where its user is,
 * so location-aware tools (#31, `getWeather`) can answer locationless
 * questions ("what's the weather?") without asking for a city first. Clients
 * with no location source (the CLI) never send it; the web client sends it
 * once its user opts in and the browser resolves a fix — which requires a
 * secure context (HTTPS or localhost), so over plain HTTP the frame simply
 * never arrives and the tool falls back to asking.
 *
 * Valid at any point in the socket's lifetime and refreshable: the latest
 * frame wins for subsequent turns. The server keeps the report in memory for
 * the socket's lifetime only — never persisted to the database, a transcript,
 * or logs at coordinate precision.
 */
export interface ClientLocationFrame {
    type: "location";
    /** Latitude in decimal degrees; finite, within [-90, 90]. */
    lat: number;
    /** Longitude in decimal degrees; finite, within [-180, 180]. */
    lon: number;
    /**
     * Optional human-readable place name ("Portland, OR") for clients that
     * know one. Browser geolocation typically does not — the server then uses
     * the location name the weather provider resolves from the coordinates.
     */
    label?: string;
}

/**
 * The turn cancellation (#84 P6): a client dropping the socket's in-flight
 * turn — JARVIS is mid-answer and the user talked over it (barge-in), or
 * pressed stop. The server aborts the model stream and the turn's spoken
 * audio, releases the thread lock, and closes the turn with `done` (the
 * text already streamed stays in history; no error frame is sent). Valid at
 * any time; a `cancel` with no in-flight turn is ignored.
 */
export interface ClientCancelFrame {
    type: "cancel";
}

/**
 * Longest optional place-name `label` a `location` frame may carry.
 *
 * Generous for "Washington, District of Columbia, United States" while
 * bounding a client bug from stuffing prose into a display field.
 */
export const MAX_LOCATION_LABEL_LENGTH = 64;

/** Longest `sessionId` a client may send in a chat request. */
export const MAX_SESSION_ID_LENGTH = 128;

/** Longest device `token` a client may send in an `auth` handshake. */
export const MAX_TOKEN_LENGTH = 128;

/**
 * Longest `capabilities` list a client may send in a `hello` frame.
 *
 * A 16-token cap bounds the frame without sacrificing the known token set,
 * which is itself bounded by the {@link CLIENT_CAPABILITIES} tuple.
 */
export const MAX_CAPABILITIES = 16;

/** Longest single capability token a client may send in a `hello` frame. */
export const MAX_CAPABILITY_LENGTH = 16;

/**
 * Longest `attachments` list a prompt may reference.
 *
 * A vision-language tool call analyzes one image per id; four bounds the
 * per-prompt analysis cost without harming any plausible use (screenshots plus
 * a photo, say).
 */
export const MAX_ATTACHMENTS = 4;

/**
 * Longest single attachment id a prompt may reference.
 *
 * Server-generated ids are 18 random bytes — 24 characters of base64url — so
 * the bound has slack for a future id scheme without re-opening the protocol.
 */
export const MAX_ATTACHMENT_ID_LENGTH = 32;
