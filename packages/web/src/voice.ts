/**
 * Voice-controller re-exports (issue #84).
 *
 * The controller lives in `@lukestanbery/jarvis-voice` (phase 3 moved it
 * next to the lifecycle it drives, so any future voice client reuses the
 * same orchestrator). This shim keeps the chat view's relative import path
 * stable; new code should import from the package directly.
 */
export {
    END_OF_SPEECH_MS,
    NO_SPEECH_MS,
    VoiceController,
} from "@lukestanbery/jarvis-voice";
export type {
    VoiceControllerOptions,
    VoiceSubmit,
} from "@lukestanbery/jarvis-voice";
