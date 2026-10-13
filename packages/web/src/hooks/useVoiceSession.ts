/**
 * Voice-session view helpers.
 *
 * Holds the pure text derivations the chat view renders from a voice snapshot;
 * it lives in a hook-named module because the next phase adds the
 * `useVoiceSession` hook here. `voiceStatusText` is pure and node-testable.
 */
import type { VoiceSnapshot } from "@lukestanbery/jarvis-voice";

/**
 * Human text for the voice session's status line (#84 P2): the live partial
 * transcript while listening, then the stage. Returns `null` once the response
 * itself is visible (responding/speaking) or there is nothing to say (idle
 * without an error) — the caller renders errors separately as an alert so a
 * failed session stays on screen until the next press.
 *
 * @param snapshot - The current voice snapshot.
 * @returns Status text, or `null` when the line should not render.
 */
export function voiceStatusText(snapshot: VoiceSnapshot): string | null {
    switch (snapshot.state) {
        case "listening":
            return snapshot.partial ?? "Listening…";
        case "transcribing":
            return "Transcribing…";
        case "submitting":
            return "Sending…";
        case "waiting":
            return "Thinking…";
        default:
            return null;
    }
}
