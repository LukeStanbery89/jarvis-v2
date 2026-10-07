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
    MAX_ATTACHMENTS,
    MAX_ATTACHMENT_ID_LENGTH,
    MAX_CAPABILITIES,
    MAX_CAPABILITY_LENGTH,
    MAX_LOCATION_LABEL_LENGTH,
    MAX_SESSION_ID_LENGTH,
    MAX_TOKEN_LENGTH,
} from "./types";
import type {
    AuthRequest,
    ChatMode,
    ChatPrompt,
    ClientCapability,
    ClientFrame,
    ClientHello,
    ClientLocationFrame,
    ServerFrame,
} from "./types";

/** The capability tokens the protocol recognizes (mirrors `ClientCapability`). */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>([
    "markdown",
    "html",
    "image",
    "link",
    "audio",
]);

/** User-facing wording for a malformed JSON payload; must not drift. */
const MALFORMED_JSON = "malformed request; expected a JSON object";

/**
 * Parses one raw server frame into a typed {@link ServerFrame}.
 *
 * Throws if the payload is not valid JSON or matches no known frame shape;
 * the thrown message is surfaced to users by `@lukestanbery/jarvis-cli`.
 */
export function parseFrame(raw: string): ServerFrame {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("received a malformed message from the server");
    }
    const frame = parsed as {
        chunk?: unknown;
        done?: unknown;
        error?: unknown;
        tool?: { name?: unknown; args?: unknown };
        toolResult?: { name?: unknown; output?: unknown };
        authResult?: { user?: unknown; device?: unknown };
        audioStart?: {
            generationId?: unknown;
            format?: unknown;
            sampleRate?: unknown;
            channels?: unknown;
        };
        audioEnd?: { generationId?: unknown };
    };
    if (typeof frame.chunk === "string") {
        return { chunk: frame.chunk };
    }
    if (frame.tool && typeof frame.tool.name === "string") {
        return { tool: { name: frame.tool.name, args: frame.tool.args } };
    }
    if (frame.toolResult && typeof frame.toolResult.name === "string") {
        return {
            toolResult: {
                name: frame.toolResult.name,
                output: frame.toolResult.output,
            },
        };
    }
    if (frame.done === true) {
        return { done: true };
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
    throw new Error("received an unrecognized message from the server");
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

/** The chat-mode tokens the protocol recognizes (mirrors `ChatMode`). */
const KNOWN_MODES: ReadonlySet<string> = new Set<string>(["text", "voice"]);

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
 * `type: "location"` message as the device-location report, and anything
 * else as a legacy {@link ChatPrompt} (which may carry an optional `mode`).
 * Throws on malformed JSON (or a non-object) or shape violations; the thrown
 * message is surfaced to users by the server's error frames and must not
 * drift.
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
