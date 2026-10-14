/**
 * Shared browser-provider scaffolding (issue #107 P2).
 *
 * The four browser providers in this directory (`webSpeech`, `vosk`,
 * `browserVad`, `openWakeWord`) previously carried hand-copied versions of
 * the same few pieces: the structural `MediaStream`/`MediaDevices` slices,
 * the `globalThis` lookups for `getUserMedia` and the `AudioContext`
 * constructor, the stream teardown, the `{ code, message }` error builder,
 * the permission-denied message heuristic, and the "open an echo-cancelled
 * mic + audio context" prologue. They now import them from here, so a fix
 * to any one of them lands everywhere at once.
 *
 * Like the providers themselves, everything here is structural (no DOM lib)
 * and side-effect free at module scope: browser APIs are read off
 * `globalThis` at call time, so node tests install fakes freely.
 *
 * This module is **internal** to the package — deliberately not re-exported
 * from `src/index.ts` — so the public API surface is unchanged.
 */
import type { VoiceError } from "../types";

/** A mic track, structurally sliced (node tests install doubles). */
export interface MediaStreamTrackLike {
    stop(): void;
    onended: (() => void) | null;
}

/** A media stream carrying one or more tracks. */
export interface MediaStreamLike {
    getTracks(): MediaStreamTrackLike[];
}

/** The slice of `MediaDevices` every capture provider needs. */
export interface MediaDevicesLike {
    getUserMedia(constraints: {
        audio: { echoCancellation: boolean };
    }): Promise<MediaStreamLike>;
}

/** One provider's capture plumbing: the mic stream plus its audio context. */
export interface MicCapture<C> {
    stream: MediaStreamLike;
    context: C;
}

/**
 * Finds `getUserMedia`, standard path (the vendor-prefixed era is over for
 * every engine these providers target — they all ship WASM).
 *
 * The function is returned **bound to its `MediaDevices` receiver**: the
 * browser requires `getUserMedia` to be invoked with the `mediaDevices`
 * object as `this` (otherwise Chrome throws `Illegal invocation`), and every
 * call site holds the function detached from its object.
 *
 * @returns The function, or `null` outside a browser that offers one
 * (node, plain-HTTP non-localhost origins, permission-less contexts).
 */
export function findUserMedia(): MediaDevicesLike["getUserMedia"] | null {
    const globals = globalThis as {
        navigator?: { mediaDevices?: MediaDevicesLike };
    };
    const devices = globals.navigator?.mediaDevices;
    if (devices?.getUserMedia === undefined) {
        return null;
    }
    return devices.getUserMedia.bind(devices);
}

/**
 * Finds the audio-context constructor, standard or prefixed, typed for the
 * caller's own structural `AudioContext` slice.
 *
 * @param slice - The caller's `AudioContextLike` (inferred from use).
 * @returns The constructor, or `null` where Web Audio is unavailable.
 */
export function findAudioContextCtor<C>(): (new () => C) | null {
    const globals = globalThis as {
        AudioContext?: new () => C;
        webkitAudioContext?: new () => C;
    };
    return globals.AudioContext ?? globals.webkitAudioContext ?? null;
}

/**
 * Stops every track of a stream, ignoring failures.
 *
 * @param stream - The stream to release, or `null`.
 */
export function releaseStream(stream: MediaStreamLike | null): void {
    if (stream === null) {
        return;
    }
    for (const track of stream.getTracks()) {
        track.onended = null;
        try {
            track.stop();
        } catch {
            // A track that will not stop is already dead.
        }
    }
}

/**
 * Builds a {@link VoiceError} (used for throws as well as deliveries).
 *
 * @param code - Machine-readable failure class.
 * @param message - Human-readable detail.
 * @returns The error object.
 */
export function voiceError(
    code: VoiceError["code"],
    message: string,
): VoiceError {
    return { code, message };
}

/**
 * Whether a rejection looks like a microphone-permission failure. Engines
 * surface permission denial through a scatter of error messages ("Permission
 * dismissed", "NotAllowedError", "Requested device not available"), so the
 * match is deliberately broad.
 *
 * @param err - The thrown value.
 * @returns True when the message reads as a permission denial.
 */
export function isPermissionDenied(err: unknown): boolean {
    return (
        err instanceof Error &&
        /permission|denied|not allowed/i.test(err.message)
    );
}

/**
 * Maps a capture `start()` rejection to a {@link VoiceError}: a
 * permission-shaped message becomes `permission-denied`, anything else is an
 * `engine` error carrying the original message (or the fallback when the
 * thrown value is not an `Error`).
 *
 * @param err - The thrown value.
 * @param fallback - Message for a non-`Error` rejection.
 * @returns The voice error to throw or deliver.
 */
export function micError(err: unknown, fallback: string): VoiceError {
    return voiceError(
        isPermissionDenied(err) ? "permission-denied" : "engine",
        err instanceof Error ? err.message : fallback,
    );
}

/**
 * Opens one provider's capture plumbing: the echo-cancelled microphone
 * stream and the caller's audio context, created in one guarded step so a
 * failure of either releases the stream (never leaks the mic) and rejects
 * with a mapped {@link VoiceError} — the prologue `vosk` and `browserVad`
 * previously duplicated verbatim.
 *
 * @param getUserMedia - The bound `getUserMedia` (the caller has already
 *   established availability and owns its own `unsupported` error).
 * @param contextCtor - The caller's audio-context constructor.
 * @param fallback - Message for a non-`Error` rejection.
 * @returns The mic stream and the fresh context.
 */
export async function openMicContext<C>(
    getUserMedia: MediaDevicesLike["getUserMedia"],
    contextCtor: new () => C,
    fallback: string,
): Promise<MicCapture<C>> {
    let stream: MediaStreamLike | null = null;
    try {
        stream = await getUserMedia({
            audio: { echoCancellation: true },
        });
        return { stream, context: new contextCtor() };
    } catch (err) {
        releaseStream(stream);
        throw micError(err, fallback);
    }
}

/**
 * Wires the stream's first track so a revoked/reaped microphone fails the
 * session mid-capture instead of leaving it silently deaf.
 *
 * @param stream - The capture stream.
 * @param onEnded - The failure path (typically `fail(voiceError(...))`).
 */
export function wireTrackEnded(
    stream: MediaStreamLike,
    onEnded: () => void,
): void {
    const track = stream.getTracks()[0];
    if (track !== undefined) {
        track.onended = onEnded;
    }
}
