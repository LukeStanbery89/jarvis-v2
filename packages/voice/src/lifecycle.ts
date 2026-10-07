/**
 * The client-side voice session lifecycle: a pure, synchronous state machine
 * over {@link VoiceEvent}s.
 *
 * One machine owns the whole interaction — press/wake through transcript
 * submission through response playback — so state is never scattered across
 * microphone, recognizer, socket, and audio components (issue #84, decision
 * in "voice interaction lifecycle"):
 *
 * ```text
 * idle ──activate──► listening ──endOfSpeech──► transcribing
 *   ▲                   │  ▲                        │
 *   │     noSpeech/fail │  │ userSpeech (barge-in)  │ transcript
 *   └───────────────────┘  │                        ▼
 *                          │                   submitting
 *                          │                        │
 *                          │                   submitted
 *                          │                        ▼
 *                          │            waiting ◄───┘
 *                          │              │ responseStarted
 *                          │              ▼
 *                          │          responding ──audioStarted──► speaking
 *                          │              │ responseEnded            │
 *                          └──────────────┴──────────────────────────┘
 * ```
 *
 * Three properties make this safe to drive from real, racy input:
 *
 * - **Session ids.** `activate`/`userSpeech` open a new session (id + 1);
 *   every recognition, submission, and response event is tagged with the
 *   session it belongs to. Events from a stale session are ignored, so a
 *   late transcript or a dying response cannot disturb the interaction that
 *   replaced it (the race matrix in issues #83/#84).
 * - **Empty transcripts never submit.** A blank or whitespace-only
 *   `transcript` event is ignored rather than moving to `submitting`.
 * - **Ignores, not throws.** An event that is illegal for the current state
 *   returns the snapshot unchanged (`next === prev`), which makes stale and
 *   out-of-order delivery harmless by construction.
 *
 * The machine is deliberately engine- and transport-agnostic: providers
 * (`./types`) produce the events, clients decide how to render each state
 * and which events to forward (e.g. submit only `submitting`'s transcript as
 * a `mode: "voice"` prompt). There is no I/O here — callers own logging
 * (route any through `@lukestanbery/jarvis-logger`) and side effects.
 */
import type { VoiceError } from "./types";

/**
 * Every state a voice session can be in, in lifecycle order. Exported as a
 * value so tests and UIs can enumerate states instead of hard-coding them.
 *
 * - `idle` — no session; microphone and wake detection are the caller's concern.
 * - `listening` — capturing; partials are displayed locally, nothing sent.
 * - `transcribing` — capture ended, waiting for the final transcript.
 * - `submitting` — a final, non-empty transcript exists; the client is about
 *   to (or is in the process of) sending it as a prompt.
 * - `waiting` — the prompt was accepted; no response frames yet.
 * - `responding` — response frames are streaming (text, and audio if any).
 * - `speaking` — TTS audio is playing; barge-in is watched from here.
 */
export const VOICE_STATES = [
    "idle",
    "listening",
    "transcribing",
    "submitting",
    "waiting",
    "responding",
    "speaking",
] as const;

/** A state from {@link VOICE_STATES}. */
export type VoiceState = (typeof VOICE_STATES)[number];

/**
 * Everything that can happen to a voice session.
 *
 * Session-scoped events carry the `sessionId` they belong to; events tagged
 * with a stale id are ignored. `activate`, `userSpeech`, and `cancel` are
 * session-agnostic triggers and carry no id.
 */
export type VoiceEvent =
    /** Open a session: the wake phrase matched or the user pressed the mic button. */
    | { type: "activate" }
    /** VAD heard the user during an active response — barge-in; opens a new session. */
    | { type: "userSpeech" }
    /** The user aborted (stop button, teardown); any session returns to `idle`. */
    | { type: "cancel" }
    /** Interim recognition text — display locally, never submit. */
    | { type: "partial"; sessionId: number; text: string }
    /** The user stopped talking (VAD end-of-speech) — move to decoding. */
    | { type: "endOfSpeech"; sessionId: number }
    /** The no-speech timeout fired before anything was recognized. */
    | { type: "noSpeech"; sessionId: number }
    /** A final, non-empty transcript is ready to become a prompt. */
    | { type: "transcript"; sessionId: number; text: string }
    /** Recognition failed; the session ends with {@link VoiceError} set. */
    | { type: "transcriptFailed"; sessionId: number; error: VoiceError }
    /** The server accepted the submitted prompt. */
    | { type: "submitted"; sessionId: number }
    /** The server refused the prompt (busy, bad prompt, turn timeout, …). */
    | { type: "rejected"; sessionId: number; error: VoiceError }
    /** The first response frame arrived; text begins streaming. */
    | { type: "responseStarted"; sessionId: number }
    /** TTS audio for this response begins; may follow `responseStarted` directly. */
    | { type: "audioStarted"; sessionId: number }
    /** The response finished (happily or via stream error); the turn is over. */
    | { type: "responseEnded"; sessionId: number };

/**
 * Immutable snapshot of a voice session. Callers hold the latest snapshot,
 * feed it events, and render from the result — there is no hidden state.
 */
export interface VoiceSnapshot {
    /** Current {@link VoiceState}. */
    readonly state: VoiceState;
    /** Id of the current session; starts at 0, increments on each activation. */
    readonly sessionId: number;
    /** Final transcript of the current session, retained until the next activation. */
    readonly transcript: string | null;
    /** Latest interim text, present only while `listening`/`transcribing`. */
    readonly partial: string | null;
    /** Failure that ended the current session, cleared on the next activation. */
    readonly error: VoiceError | null;
}

/** The snapshot every session starts from: `idle`, session 0, nothing recorded. */
export const initialVoiceSnapshot: VoiceSnapshot = {
    state: "idle",
    sessionId: 0,
    transcript: null,
    partial: null,
    error: null,
};

/**
 * Opens a new listening session (id + 1) with a clean slate.
 *
 * @param snapshot - Current snapshot to advance.
 * @returns The next snapshot, in `listening`.
 */
function beginListening(snapshot: VoiceSnapshot): VoiceSnapshot {
    return {
        state: "listening",
        sessionId: snapshot.sessionId + 1,
        transcript: null,
        partial: null,
        error: null,
    };
}

/**
 * Moves to `state`, clearing the partial (it only means something while
 * decoding) and optionally recording a transcript or error, while keeping
 * the session id and any not-explicitly-replaced fields.
 *
 * @param snapshot - Current snapshot to advance.
 * @param state - State to enter.
 * @param patch - Transcript and/or error to record alongside the transition.
 * @returns The next snapshot.
 */
function transition(
    snapshot: VoiceSnapshot,
    state: VoiceState,
    patch: { transcript?: string; error?: VoiceError } = {},
): VoiceSnapshot {
    return {
        state,
        sessionId: snapshot.sessionId,
        transcript: patch.transcript ?? snapshot.transcript,
        partial: null,
        error: patch.error ?? snapshot.error,
    };
}

/**
 * The voice session reducer: applies one {@link VoiceEvent} to a snapshot.
 *
 * Pure and total — same inputs give the same output, and an event that does
 * not apply returns the snapshot by identity so callers can detect "ignored"
 * with `next === prev`. The full transition table is exercised by
 * `test/lifecycle.test.ts`.
 *
 * @param snapshot - Current session snapshot.
 * @param event - Event to apply.
 * @returns The next snapshot (the same reference if the event was ignored).
 */
export function reduceVoice(
    snapshot: VoiceSnapshot,
    event: VoiceEvent,
): VoiceSnapshot {
    if (
        event.type !== "activate" &&
        event.type !== "userSpeech" &&
        event.type !== "cancel" &&
        event.sessionId !== snapshot.sessionId
    ) {
        return snapshot;
    }
    switch (event.type) {
        case "activate":
            // Re-arming is only safe when nothing is mid-flight: from an
            // active response it is a wake-word barge-in (the caller must
            // cancel the old turn); from listening/transcribing/submitting
            // it would clobber a session in progress — cancel first.
            if (
                snapshot.state !== "idle" &&
                snapshot.state !== "waiting" &&
                snapshot.state !== "responding" &&
                snapshot.state !== "speaking"
            ) {
                return snapshot;
            }
            return beginListening(snapshot);
        case "userSpeech":
            if (
                snapshot.state !== "waiting" &&
                snapshot.state !== "responding" &&
                snapshot.state !== "speaking"
            ) {
                return snapshot;
            }
            return beginListening(snapshot);
        case "cancel":
            if (snapshot.state === "idle") {
                return snapshot;
            }
            return transition(snapshot, "idle");
        case "partial":
            if (
                snapshot.state !== "listening" &&
                snapshot.state !== "transcribing"
            ) {
                return snapshot;
            }
            return { ...snapshot, partial: event.text };
        case "endOfSpeech":
            if (snapshot.state !== "listening") {
                return snapshot;
            }
            return transition(snapshot, "transcribing");
        case "noSpeech":
            if (
                snapshot.state !== "listening" &&
                snapshot.state !== "transcribing"
            ) {
                return snapshot;
            }
            return transition(snapshot, "idle");
        case "transcript":
            if (
                snapshot.state !== "listening" &&
                snapshot.state !== "transcribing"
            ) {
                return snapshot;
            }
            // Never submit an empty message: blank recognition results keep
            // the session where it is instead of reaching `submitting`.
            if (event.text.trim() === "") {
                return snapshot;
            }
            return transition(snapshot, "submitting", {
                transcript: event.text,
            });
        case "transcriptFailed":
            if (
                snapshot.state !== "listening" &&
                snapshot.state !== "transcribing"
            ) {
                return snapshot;
            }
            return transition(snapshot, "idle", { error: event.error });
        case "submitted":
            if (snapshot.state !== "submitting") {
                return snapshot;
            }
            return transition(snapshot, "waiting");
        case "rejected":
            if (
                snapshot.state !== "submitting" &&
                snapshot.state !== "waiting" &&
                snapshot.state !== "responding" &&
                snapshot.state !== "speaking"
            ) {
                return snapshot;
            }
            return transition(snapshot, "idle", { error: event.error });
        case "responseStarted":
            if (snapshot.state !== "waiting") {
                return snapshot;
            }
            return transition(snapshot, "responding");
        case "audioStarted":
            // TTS may open the turn before any text frame is observed.
            if (
                snapshot.state !== "waiting" &&
                snapshot.state !== "responding"
            ) {
                return snapshot;
            }
            return transition(snapshot, "speaking");
        case "responseEnded":
            if (
                snapshot.state !== "waiting" &&
                snapshot.state !== "responding" &&
                snapshot.state !== "speaking"
            ) {
                return snapshot;
            }
            return transition(snapshot, "idle");
    }
}
