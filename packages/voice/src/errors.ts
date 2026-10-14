/**
 * Shared error normalization for the voice internals (issues #104, #110).
 *
 * Providers throw {@link VoiceError}-shaped objects, but not every rejection
 * is one — a browser `DOMException`, a `TypeError` from a bad seam, or a
 * bare value can all surface from an engine. Every user-facing failure path
 * funnels through here so the reducer always receives a well-formed error.
 */
import type { VoiceError } from "./types";

/**
 * Normalizes an unknown rejection into a {@link VoiceError} (provider throws
 * are already `VoiceError`-shaped; anything else becomes an engine error).
 *
 * @param err - The thrown value.
 * @returns A voice error.
 */
export function toVoiceError(err: unknown): VoiceError {
    if (typeof err === "object" && err !== null) {
        const candidate = err as { code?: unknown; message?: unknown };
        if (
            typeof candidate.code === "string" &&
            typeof candidate.message === "string"
        ) {
            return {
                code: candidate.code as VoiceError["code"],
                message: candidate.message,
            };
        }
    }
    return {
        code: "engine",
        message: err instanceof Error ? err.message : "voice input failed",
    };
}
