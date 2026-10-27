/**
 * Parsing and serialization for the J.A.R.V.I.S. chat wire protocol.
 *
 * These are the only functions allowed to turn raw WebSocket payloads into
 * typed frames (and back), so the server (`@lukestanbery/jarvis-server`'s `ws.ts`) and the
 * CLI (`@lukestanbery/jarvis-cli`'s `client.ts`) share one implementation of the framing
 * rules. Everything here is a pure data transformation with no I/O.
 *
 * Behavior is deliberately conservative and unchanged from the historical
 * hand-written copies: unknown JSON shapes are rejected as unrecognized, and
 * the error message wording is user-facing (the CLI surfaces it verbatim) so
 * it must not drift.
 */
import {
    CHAT_MODES,
    CLIENT_CAPABILITIES,
    MAX_ATTACHMENTS,
    MAX_ATTACHMENT_ID_LENGTH,
    MAX_CAPABILITIES,
    MAX_CAPABILITY_LENGTH,
    MAX_LOCATION_LABEL_LENGTH,
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
} from "./types";
import type {
    AuthRequest,
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
    ToolSource,
} from "./types";

/**
 * The capability tokens the protocol recognizes, derived from
 * {@link CLIENT_CAPABILITIES} so the parser cannot drift from the union.
 */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>(
    CLIENT_CAPABILITIES,
);

/**
 * The chat-mode tokens the protocol recognizes, derived from
 * {@link CHAT_MODES} so the parser cannot drift from the union.
 */
const KNOWN_MODES: ReadonlySet<string> = new Set<string>(CHAT_MODES);

/**
 * The notification-priority tokens the protocol recognizes, derived from
 * {@link NOTIFICATION_PRIORITIES} for the same reason.
 */
const KNOWN_NOTIFICATION_PRIORITIES: ReadonlySet<string> = new Set<string>(
    NOTIFICATION_PRIORITIES,
);

/**
 * The notification-class tokens the protocol recognizes, derived from
 * {@link NOTIFICATION_CLASSES} for the same reason.
 */
const KNOWN_NOTIFICATION_CLASSES: ReadonlySet<string> = new Set<string>(
    NOTIFICATION_CLASSES,
);

/** User-facing wording for a malformed JSON payload; must not drift. */
const MALFORMED_JSON = "malformed request; expected a JSON object";

/**
 * User-facing wording for a server frame the parser cannot read (not JSON,
 * or JSON but not an object) — exported so clients can fail with the
 * canonical message instead of hand-copying it (#106).
 */
export const MALFORMED_SERVER_FRAME =
    "received a malformed message from the server";

/**
 * Parses one raw server frame into a typed {@link ServerFrame}.
 *
 * Throws if the payload is not valid JSON, is not an object, or matches no
 * known frame shape; the first two throw {@link MALFORMED_SERVER_FRAME}'s
 * wording, which is surfaced to users by `@lukestanbery/jarvis-cli`.
 */
export function parseFrame(raw: string): ServerFrame {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(MALFORMED_SERVER_FRAME);
    }
    if (typeof parsed !== "object" || parsed === null) {
        // Without this guard a JSON `null` (or a bare number/string) reached
        // the field checks below and threw a raw TypeError instead of the
        // user-facing wording (#106).
        throw new Error(MALFORMED_SERVER_FRAME);
    }
    const frame = parsed as {
        chunk?: unknown;
        done?: unknown;
        error?: unknown;
        tool?: { name?: unknown; args?: unknown };
        toolResult?: { name?: unknown; output?: unknown; sources?: unknown };
        authResult?: { user?: unknown; device?: unknown };
        audioStart?: {
            generationId?: unknown;
            format?: unknown;
            sampleRate?: unknown;
            channels?: unknown;
        };
        audioEnd?: { generationId?: unknown };
        notification?: unknown;
        sessionTitle?: { sessionId?: unknown; title?: unknown };
    };
    if (typeof frame.chunk === "string") {
        return { chunk: frame.chunk };
    }
    if (frame.tool && typeof frame.tool.name === "string") {
        return { tool: { name: frame.tool.name, args: frame.tool.args } };
    }
    if (frame.toolResult && typeof frame.toolResult.name === "string") {
        const sources = normalizeToolSources(frame.toolResult.sources);
        return {
            toolResult: {
                name: frame.toolResult.name,
                output: frame.toolResult.output,
                ...(sources !== undefined ? { sources } : {}),
            },
        };
    }
    if (frame.done === true) {
        return { done: true };
    }
    if (
        frame.sessionTitle &&
        typeof frame.sessionTitle.sessionId === "string" &&
        frame.sessionTitle.sessionId.length > 0 &&
        frame.sessionTitle.sessionId.length <= MAX_SESSION_ID_LENGTH &&
        typeof frame.sessionTitle.title === "string" &&
        frame.sessionTitle.title.trim().length > 0 &&
        frame.sessionTitle.title.length <= MAX_SESSION_TITLE_LENGTH
    ) {
        return {
            sessionTitle: {
                sessionId: frame.sessionTitle.sessionId,
                title: frame.sessionTitle.title,
            },
        };
    }
    if (typeof frame.error === "string") {
        return { error: frame.error };
    }
    if (
        frame.audioStart &&
        typeof frame.audioStart.generationId === "number" &&
        Number.isInteger(frame.audioStart.generationId) &&
        frame.audioStart.format === "pcm_s16le" &&
        typeof frame.audioStart.sampleRate === "number" &&
        Number.isFinite(frame.audioStart.sampleRate) &&
        frame.audioStart.sampleRate > 0 &&
        frame.audioStart.channels === 1
    ) {
        return {
            audioStart: {
                generationId: frame.audioStart.generationId,
                format: "pcm_s16le",
                sampleRate: frame.audioStart.sampleRate,
                channels: 1,
            },
        };
    }
    if (
        frame.audioEnd &&
        typeof frame.audioEnd.generationId === "number" &&
        Number.isInteger(frame.audioEnd.generationId)
    ) {
        return { audioEnd: { generationId: frame.audioEnd.generationId } };
    }
    if (
        frame.authResult &&
        typeof frame.authResult.user === "string" &&
        typeof frame.authResult.device === "string"
    ) {
        return {
            authResult: {
                user: frame.authResult.user,
                device: frame.authResult.device,
            },
        };
    }
    if (frame.notification) {
        const parsed = parseNotificationFrame(frame.notification);
        if (parsed !== null) {
            return parsed;
        }
    }
    throw new Error("received an unrecognized message from the server");
}

/**
 * Normalizes the optional original-source list on a `toolResult` frame (#199).
 *
 * Source metadata is presentation-only, so a malformed entry must never take
 * down the tool result it describes: invalid items are skipped and an absent
 * (or wholly invalid) list is normalized away. URLs are limited to absolute
 * `http(s)` links here as defense in depth; the UI still runs each one through
 * its own allowlist before creating an anchor.
 *
 * @param payload - The raw `toolResult.sources` value.
 * @returns The validated sources in wire order, or `undefined` when none.
 */
export function normalizeToolSources(
    payload: unknown,
): ToolSource[] | undefined {
    if (!Array.isArray(payload)) {
        return undefined;
    }
    const sources: ToolSource[] = [];
    for (const raw of payload.slice(0, MAX_TOOL_SOURCES)) {
        if (typeof raw !== "object" || raw === null) {
            continue;
        }
        const item = raw as { title?: unknown; url?: unknown };
        if (typeof item.title !== "string" || typeof item.url !== "string") {
            continue;
        }
        const title = item.title.trim();
        const url = item.url.trim();
        if (
            title.length === 0 ||
            title.length > MAX_TOOL_SOURCE_TITLE_LENGTH ||
            url.length === 0 ||
            url.length > MAX_TOOL_SOURCE_URL_LENGTH
        ) {
            continue;
        }
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            continue;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            continue;
        }
        sources.push({ title, url: parsed.href });
    }
    return sources.length > 0 ? sources : undefined;
}

/**
 * Validates the `notification` payload of a server frame (#139), returning the
 * typed frame or `null` when the payload is not one this protocol version can
 * render.
 *
 * Bounds are enforced here rather than trusted: the server is the only writer,
 * but the shared parser is what every client relies on to know a frame is
 * displayable, and an unbounded `title`/`body` arriving from a future or
 * misbehaving server must not become unbounded client state. Optional fields
 * are normalized away when absent so consumers get one shape, and an
 * over-long string is a rejected frame rather than a truncated one — silently
 * cutting a notification's text would hide the fact that the sender and the
 * receiver disagree about the protocol.
 */
function parseNotificationFrame(payload: unknown): NotificationFrame | null {
    if (typeof payload !== "object" || payload === null) {
        return null;
    }
    const n = payload as {
        id?: unknown;
        kind?: unknown;
        class?: unknown;
        priority?: unknown;
        title?: unknown;
        body?: unknown;
        createdAt?: unknown;
        requiresAnswer?: unknown;
        jobId?: unknown;
    };
    if (
        typeof n.id !== "string" ||
        n.id.length === 0 ||
        n.id.length > MAX_NOTIFICATION_ID_LENGTH ||
        typeof n.kind !== "string" ||
        n.kind.length === 0 ||
        n.kind.length > MAX_NOTIFICATION_KIND_LENGTH ||
        typeof n.title !== "string" ||
        n.title.length === 0 ||
        n.title.length > MAX_NOTIFICATION_TITLE_LENGTH ||
        typeof n.createdAt !== "string" ||
        !isNotificationClass(n.class) ||
        !isNotificationPriority(n.priority)
    ) {
        return null;
    }
    if (
        n.body !== undefined &&
        (typeof n.body !== "string" ||
            n.body.length > MAX_NOTIFICATION_BODY_LENGTH)
    ) {
        return null;
    }
    if (
        n.requiresAnswer !== undefined &&
        typeof n.requiresAnswer !== "boolean"
    ) {
        return null;
    }
    if (
        n.jobId !== undefined &&
        (typeof n.jobId !== "string" ||
            n.jobId.length === 0 ||
            n.jobId.length > MAX_NOTIFICATION_ID_LENGTH)
    ) {
        return null;
    }
    return {
        notification: {
            id: n.id,
            kind: n.kind,
            class: n.class,
            priority: n.priority,
            title: n.title,
            ...(typeof n.body === "string" && n.body.length > 0
                ? { body: n.body }
                : {}),
            createdAt: n.createdAt,
            ...(n.requiresAnswer === true ? { requiresAnswer: true } : {}),
            ...(typeof n.jobId === "string" && n.jobId.length > 0
                ? { jobId: n.jobId }
                : {}),
        },
    };
}

/**
 * True when `value` is one of the {@link NOTIFICATION_PRIORITIES} tokens.
 *
 * Derived from the shared tuple, so a priority added to the protocol cannot be
 * silently unparsable — the set and the union move together.
 */
function isNotificationPriority(value: unknown): value is NotificationPriority {
    return (
        typeof value === "string" &&
        (KNOWN_NOTIFICATION_PRIORITIES as ReadonlySet<string>).has(value)
    );
}

/**
 * True when `value` is one of the {@link NOTIFICATION_CLASSES} tokens.
 *
 * A class must come from the closed set for the same reason a priority must:
 * a client choosing how insistently to render a frame it does not recognize
 * would be guessing about the one field that decides whether a timer is
 * impossible to miss.
 */
function isNotificationClass(value: unknown): value is NotificationClass {
    return (
        typeof value === "string" &&
        (KNOWN_NOTIFICATION_CLASSES as ReadonlySet<string>).has(value)
    );
}

/** Parses raw wire text into a plain object, or throws the shared wording. */
function parseJson(raw: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(MALFORMED_JSON);
    }
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error(MALFORMED_JSON);
    }
    return parsed as Record<string, unknown>;
}

/**
 * Parses + validates a ChatPrompt-shaped object.
 *
 * Throws if `prompt` or `sessionId` are not non-empty trimmed strings, if
 * `sessionId` exceeds {@link MAX_SESSION_ID_LENGTH} characters, if `mode`
 * is present but not `"text"` or `"voice"`, or if `attachments` is present
 * but not an array of at most {@link MAX_ATTACHMENTS} unique, non-empty ids
 * each at most {@link MAX_ATTACHMENT_ID_LENGTH} characters. Absent `mode`
 * and `attachments` are omitted from the parsed frame, so legacy prompts
 * round-trip unchanged; an empty `attachments` array is valid and means "no
 * attachments".
 */
function validateChatPrompt(request: {
    prompt?: unknown;
    sessionId?: unknown;
    mode?: unknown;
    attachments?: unknown;
}): ChatPrompt {
    if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
        throw new Error("expected a non-empty string field 'prompt'");
    }
    if (
        typeof request.sessionId !== "string" ||
        request.sessionId.trim() === ""
    ) {
        throw new Error("expected a non-empty string field 'sessionId'");
    }
    if (request.prompt.length > MAX_PROMPT_LENGTH) {
        throw new Error(
            `prompt must be at most ${MAX_PROMPT_LENGTH} characters`,
        );
    }
    if (request.sessionId.length > MAX_SESSION_ID_LENGTH) {
        throw new Error(
            `sessionId must be at most ${MAX_SESSION_ID_LENGTH} characters`,
        );
    }
    const attachments = validateAttachments(request.attachments);
    if (request.mode === undefined) {
        return attachments === undefined
            ? { prompt: request.prompt, sessionId: request.sessionId }
            : {
                  prompt: request.prompt,
                  sessionId: request.sessionId,
                  attachments,
              };
    }
    if (typeof request.mode !== "string" || !KNOWN_MODES.has(request.mode)) {
        throw new Error("expected 'mode' to be 'text' or 'voice'");
    }
    return attachments === undefined
        ? {
              prompt: request.prompt,
              sessionId: request.sessionId,
              mode: request.mode as ChatMode,
          }
        : {
              prompt: request.prompt,
              sessionId: request.sessionId,
              mode: request.mode as ChatMode,
              attachments,
          };
}

/**
 * Validates a prompt's optional `attachments` id list.
 *
 * Returns `undefined` for an absent field (so the parsed frame omits the key),
 * and otherwise a validated array: at most {@link MAX_ATTACHMENTS} entries,
 * each a non-empty string of at most {@link MAX_ATTACHMENT_ID_LENGTH}
 * characters, with no duplicates (a repeated id is always a client bug —
 * analyzing one image twice in a prompt is meaningless).
 */
function validateAttachments(value: unknown): string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new Error("expected 'attachments' to be an array of ids");
    }
    if (value.length > MAX_ATTACHMENTS) {
        throw new Error(
            `at most ${MAX_ATTACHMENTS} attachments may be referenced`,
        );
    }
    const attachments: string[] = [];
    for (const id of value) {
        if (typeof id !== "string" || id.trim() === "") {
            throw new Error("every attachment id must be a non-empty string");
        }
        if (id.length > MAX_ATTACHMENT_ID_LENGTH) {
            throw new Error(
                `each attachment id is at most ${MAX_ATTACHMENT_ID_LENGTH} characters`,
            );
        }
        if (attachments.includes(id)) {
            throw new Error(`duplicate attachment id '${id}'`);
        }
        attachments.push(id);
    }
    return attachments;
}

/**
 * Validates an `auth` handshake object.
 *
 * Throws if `token` is not a non-empty trimmed string or exceeds
 * {@link MAX_TOKEN_LENGTH} characters.
 */
function validateAuthRequest(request: { token?: unknown }): AuthRequest {
    if (typeof request.token !== "string" || request.token.trim() === "") {
        throw new Error("expected a non-empty string field 'token'");
    }
    if (request.token.length > MAX_TOKEN_LENGTH) {
        throw new Error(`token must be at most ${MAX_TOKEN_LENGTH} characters`);
    }
    return { type: "auth", token: request.token };
}

/**
 * Validates a `hello` capability-announcement object.
 *
 * Throws if `capabilities` is not an array of known, non-empty, trimmed
 * tokens, if any token exceeds {@link MAX_CAPABILITY_LENGTH} characters, or
 * if the list exceeds {@link MAX_CAPABILITIES} entries. An empty array is
 * valid — it declares "renders plain text only". Deduplicates the list so a
 * repeated token cannot bloat the bounds.
 */
function validateClientHello(request: { capabilities?: unknown }): ClientHello {
    if (!Array.isArray(request.capabilities)) {
        throw new Error("expected a 'capabilities' array");
    }
    if (request.capabilities.length > MAX_CAPABILITIES) {
        throw new Error(`at most ${MAX_CAPABILITIES} capabilities may be sent`);
    }
    const capabilities: ClientCapability[] = [];
    for (const token of request.capabilities) {
        if (typeof token !== "string" || token.trim() === "") {
            throw new Error("every capability must be a non-empty string");
        }
        if (token.length > MAX_CAPABILITY_LENGTH) {
            throw new Error(
                `each capability is at most ${MAX_CAPABILITY_LENGTH} characters`,
            );
        }
        const capability = token as ClientCapability;
        if (!KNOWN_CAPABILITIES.has(capability)) {
            throw new Error(`unknown capability '${token}'`);
        }
        if (capabilities.includes(capability)) {
            throw new Error(`duplicate capability '${token}'`);
        }
        capabilities.push(capability);
    }
    return { type: "hello", capabilities };
}

/**
 * Validates a `location` device-report object (#31).
 *
 * Throws unless `lat` and `lon` are finite numbers within their geographic
 * ranges (-90..90 and -180..180 — JSON cannot carry NaN/Infinity, but an
 * overflow literal like 1e999 parses to `Infinity`, so finiteness is checked
 * explicitly), and, when `label` is present, unless it is a non-empty
 * (after trimming) string of at most {@link MAX_LOCATION_LABEL_LENGTH}
 * characters. An absent label omits the key from the parsed frame; the label
 * itself is stored verbatim (trims are validation-only, matching every other
 * protocol string).
 */
function validateClientLocation(request: {
    lat?: unknown;
    lon?: unknown;
    label?: unknown;
}): ClientLocationFrame {
    if (
        typeof request.lat !== "number" ||
        !Number.isFinite(request.lat) ||
        request.lat < -90 ||
        request.lat > 90
    ) {
        throw new Error("expected a finite 'lat' between -90 and 90");
    }
    if (
        typeof request.lon !== "number" ||
        !Number.isFinite(request.lon) ||
        request.lon < -180 ||
        request.lon > 180
    ) {
        throw new Error("expected a finite 'lon' between -180 and 180");
    }
    if (request.label === undefined) {
        return { type: "location", lat: request.lat, lon: request.lon };
    }
    if (typeof request.label !== "string" || request.label.trim() === "") {
        throw new Error("expected 'label' to be a non-empty string");
    }
    if (request.label.length > MAX_LOCATION_LABEL_LENGTH) {
        throw new Error(
            `label must be at most ${MAX_LOCATION_LABEL_LENGTH} characters`,
        );
    }
    return {
        type: "location",
        lat: request.lat,
        lon: request.lon,
        label: request.label,
    };
}

/**
 * Parses one raw client message into a typed {@link ClientFrame}.
 *
 * A `type: "auth"` message is validated as the first-frame handshake, a
 * `type: "hello"` message as the first-frame capability announcement, a
 * `type: "location"` message as the device-location report, a
 * `type: "cancel"` message (#84 P6) as the in-flight-turn cancellation, and
 * anything else as a legacy {@link ChatPrompt} (which may carry an optional
 * `mode`). Throws on malformed JSON (or a non-object) or shape violations;
 * the thrown message is surfaced to users by the server's error frames and
 * must not drift.
 */
export function parseClientMessage(raw: string): ClientFrame {
    const msg = parseJson(raw) as {
        type?: unknown;
        token?: unknown;
        capabilities?: unknown;
        lat?: unknown;
        lon?: unknown;
        label?: unknown;
        prompt?: unknown;
        sessionId?: unknown;
        mode?: unknown;
        attachments?: unknown;
    };
    if (msg.type === "auth") {
        return validateAuthRequest({ token: msg.token });
    }
    if (msg.type === "hello") {
        return validateClientHello({ capabilities: msg.capabilities });
    }
    if (msg.type === "location") {
        return validateClientLocation(msg);
    }
    if (msg.type === "cancel") {
        // A bare marker with no payload (#84 P6): nothing to validate. Extra
        // keys are ignored — the frame is defined by its type alone.
        return { type: "cancel" };
    }
    return validateChatPrompt(msg);
}

/**
 * Parses one raw client request into a validated {@link ChatPrompt}.
 *
 * Kept for callers that chat (and maybe authenticate): identical to the
 * prompt branch of {@link parseClientMessage}. Throws if the payload is not
 * valid JSON, if `prompt` or `sessionId` are not non-empty trimmed strings,
 * if `sessionId` exceeds {@link MAX_SESSION_ID_LENGTH} characters, or if
 * `mode` is present but not `"text"` or `"voice"`.
 */
export function parseRequest(raw: string): ChatPrompt {
    return validateChatPrompt(parseJson(raw));
}

/** Serializes a server frame to its wire JSON text. */
export function serializeFrame(frame: ServerFrame): string {
    return JSON.stringify(frame);
}

/**
 * Optional extras for {@link serializeRequest}.
 *
 * Kept as a named export so callers passing attachments can type their
 * variable without redeclaring the shape.
 */
export interface SerializeRequestOptions {
    /** The chat mode; omitted keys mean `"text"` on the wire (`mode` absent). */
    mode?: ChatMode;
    /** Attachment ids the prompt references; an empty list serializes nothing. */
    attachments?: string[];
}

/**
 * Serializes a client chat request to its wire JSON text.
 *
 * The two-argument wire shape stays byte-identical to the historical
 * `{"prompt","sessionId"}` frame, so older clients are unaffected. A present
 * `mode` serializes as a `"mode"` key (including an explicit `"text"`), and
 * non-empty `attachments` as an `"attachments"` array of ids — an empty list
 * serializes nothing, matching an absent key on the wire.
 */
export function serializeRequest(
    prompt: string,
    sessionId: string,
    options: SerializeRequestOptions = {},
): string {
    return JSON.stringify({
        prompt,
        sessionId,
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        ...(options.attachments?.length
            ? { attachments: options.attachments }
            : {}),
    });
}

/** Serializes the `auth` handshake frame to its wire JSON text. */
export function serializeAuth(token: string): string {
    return JSON.stringify({ type: "auth", token } satisfies AuthRequest);
}

/** Serializes the `hello` capability-announcement frame to its wire JSON text. */
export function serializeHello(capabilities: ClientCapability[]): string {
    return JSON.stringify({
        type: "hello",
        capabilities,
    } satisfies ClientHello);
}

/** Serializes the `cancel` turn-cancellation frame (#84 P6) to its wire JSON text. */
export function serializeCancel(): string {
    return JSON.stringify({ type: "cancel" } satisfies ClientCancelFrame);
}

/**
 * Serializes a `location` device-report frame (#31) to its wire JSON text.
 *
 * The caller passes already-rounded coordinates (the web client rounds to
 * four decimals, ~11 m); this function does no math. An absent `label`
 * serializes nothing, matching an absent key on the wire.
 */
export function serializeLocation(
    lat: number,
    lon: number,
    label?: string,
): string {
    return JSON.stringify({
        type: "location",
        lat,
        lon,
        ...(label !== undefined ? { label } : {}),
    } satisfies ClientLocationFrame);
}

/**
 * Encodes mono float PCM as little-endian signed 16-bit bytes — the wire
 * format of the binary messages inside an `audioStart`…`audioEnd` span
 * (#83). Samples are clamped to [-1, 1] (Kokoro output can overshoot a
 * hair) and rounded toward nearest.
 *
 * @param pcm - Float32 samples in [-1, 1]-ish, mono.
 * @returns The raw s16le bytes; one WebSocket binary message per call.
 */
export function pcmToS16le(pcm: Float32Array): Buffer {
    const out = Buffer.alloc(pcm.length * 2);
    for (let i = 0; i < pcm.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, pcm[i] ?? 0));
        out.writeInt16LE(Math.round(clamped * 32767), i * 2);
    }
    return out;
}

/**
 * Decodes little-endian signed 16-bit PCM bytes back to mono float samples
 * — the client-side half of {@link pcmToS16le} (#83).
 *
 * @param bytes - Raw s16le bytes (a binary WebSocket message).
 * @returns Float32 samples in [-1, 1], ready for an AudioContext buffer.
 */
export function s16leToPcm(bytes: Uint8Array): Float32Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(Math.floor(bytes.byteLength / 2));
    for (let i = 0; i < out.length; i += 1) {
        out[i] = view.getInt16(i * 2, true) / 32768;
    }
    return out;
}
