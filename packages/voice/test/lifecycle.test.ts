/**
 * Voice session lifecycle tests (issue #84, phase 1).
 *
 * The state machine is pure, so every case reduces an explicit start
 * snapshot through a scripted event list and asserts on the resulting
 * snapshot — including identity checks (`toBe`) for events that must be
 * ignored, which is how staleness and illegal transitions stay harmless.
 */
import { describe, expect, it } from "vitest";
import { VOICE_STATES, initialVoiceSnapshot, reduceVoice } from "../src/index";
import type { VoiceEvent, VoiceSnapshot, VoiceState } from "../src/index";

/** Reduces a snapshot through a script of events. */
function run(snapshot: VoiceSnapshot, ...events: VoiceEvent[]): VoiceSnapshot {
    return events.reduce(reduceVoice, snapshot);
}

/**
 * Builds a snapshot in the requested state, one legal transition at a time,
 * starting from a fresh press-to-talk session (session id 1 by default).
 */
function sessionIn(state: VoiceState, sid = 1): VoiceSnapshot {
    switch (state) {
        case "idle":
            return initialVoiceSnapshot;
        case "listening":
            return run(initialVoiceSnapshot, { type: "activate" });
        case "transcribing":
            return run(sessionIn("listening"), {
                type: "endOfSpeech",
                sessionId: sid,
            });
        case "submitting":
            return run(sessionIn("transcribing", sid), {
                type: "transcript",
                sessionId: sid,
                text: "hello",
            });
        case "waiting":
            return run(sessionIn("submitting", sid), {
                type: "submitted",
                sessionId: sid,
            });
        case "responding":
            return run(sessionIn("waiting", sid), {
                type: "responseStarted",
                sessionId: sid,
            });
        case "speaking":
            return run(sessionIn("responding", sid), {
                type: "audioStarted",
                sessionId: sid,
            });
    }
}

describe("initial snapshot", () => {
    it("starts idle with session 0 and nothing recorded", () => {
        expect(initialVoiceSnapshot).toEqual({
            state: "idle",
            sessionId: 0,
            transcript: null,
            partial: null,
            error: null,
            wakeArmed: false,
        });
    });

    it("declares a unique, complete state list", () => {
        expect(new Set(VOICE_STATES).size).toBe(VOICE_STATES.length);
        expect(VOICE_STATES).toEqual([
            "idle",
            "listening",
            "transcribing",
            "submitting",
            "waiting",
            "responding",
            "speaking",
        ]);
    });
});

describe("happy path", () => {
    it("walks press-to-talk through a voiced round trip", () => {
        let s = reduceVoice(initialVoiceSnapshot, { type: "activate" });
        expect(s.state).toBe("listening");
        expect(s.sessionId).toBe(1);

        s = run(s, {
            type: "partial",
            sessionId: 1,
            text: "turn on the",
        });
        expect(s.state).toBe("listening");
        expect(s.partial).toBe("turn on the");

        s = reduceVoice(s, { type: "endOfSpeech", sessionId: 1 });
        expect(s.state).toBe("transcribing");
        expect(s.partial).toBeNull();

        s = reduceVoice(s, {
            type: "transcript",
            sessionId: 1,
            text: "turn on the living room light",
        });
        expect(s.state).toBe("submitting");
        expect(s.transcript).toBe("turn on the living room light");

        s = reduceVoice(s, { type: "submitted", sessionId: 1 });
        expect(s.state).toBe("waiting");

        s = reduceVoice(s, { type: "responseStarted", sessionId: 1 });
        expect(s.state).toBe("responding");

        s = reduceVoice(s, { type: "audioStarted", sessionId: 1 });
        expect(s.state).toBe("speaking");

        s = reduceVoice(s, { type: "responseEnded", sessionId: 1 });
        expect(s.state).toBe("idle");
        expect(s.transcript).toBe("turn on the living room light");
        expect(s.error).toBeNull();
    });

    it("accepts a final transcript straight from listening (streaming engine)", () => {
        const s = run(
            initialVoiceSnapshot,
            { type: "activate" },
            {
                type: "transcript",
                sessionId: 1,
                text: "one breath hello",
            },
        );
        expect(s.state).toBe("submitting");
        expect(s.transcript).toBe("one breath hello");
    });

    it("a text-only response never reaches the speaking state", () => {
        const s = run(
            sessionIn("waiting"),
            { type: "responseStarted", sessionId: 1 },
            { type: "responseEnded", sessionId: 1 },
        );
        expect(s.state).toBe("idle");
    });

    it("audio can open the turn before any text frame", () => {
        const s = run(sessionIn("waiting"), {
            type: "audioStarted",
            sessionId: 1,
        });
        expect(s.state).toBe("speaking");
    });

    it("retains the transcript across a successful turn and clears it on re-activation", () => {
        const ended = run(sessionIn("waiting"), {
            type: "responseEnded",
            sessionId: 1,
        });
        expect(ended.state).toBe("idle");
        expect(ended.transcript).toBe("hello");

        const next = reduceVoice(ended, { type: "activate" });
        expect(next.sessionId).toBe(2);
        expect(next.transcript).toBeNull();
        expect(next.partial).toBeNull();
        expect(next.error).toBeNull();
    });
});

describe("guards", () => {
    it("never submits an empty or whitespace-only transcript", () => {
        for (const text of ["", "   ", "\t\n"]) {
            const s = reduceVoice(sessionIn("listening"), {
                type: "transcript",
                sessionId: 1,
                text,
            });
            expect(s.state).toBe("listening");
            expect(s.transcript).toBeNull();
        }
    });

    it("ignores a duplicate end-of-speech", () => {
        const before = sessionIn("transcribing");
        const s = reduceVoice(before, {
            type: "endOfSpeech",
            sessionId: 1,
        });
        expect(s).toBe(before);
    });

    it("ignores responseStarted before the prompt was accepted", () => {
        for (const state of ["submitting", "listening", "idle"] as const) {
            const before = sessionIn(state);
            const s = reduceVoice(before, {
                type: "responseStarted",
                sessionId: before.sessionId,
            });
            expect(s).toBe(before);
        }
    });

    it("ignores audioStarted while not waiting on a response", () => {
        for (const state of ["idle", "listening", "submitting"] as const) {
            const before = sessionIn(state);
            const s = reduceVoice(before, {
                type: "audioStarted",
                sessionId: before.sessionId,
            });
            expect(s).toBe(before);
        }
    });

    it("ignores responseEnded when no response is active", () => {
        for (const state of ["idle", "listening", "submitting"] as const) {
            const before = sessionIn(state);
            const s = reduceVoice(before, {
                type: "responseEnded",
                sessionId: before.sessionId,
            });
            expect(s).toBe(before);
        }
    });

    it("re-activation mid-decode is ignored; cancel-then-restart works", () => {
        for (const state of [
            "listening",
            "transcribing",
            "submitting",
        ] as const) {
            const inProgress = sessionIn(state);
            expect(reduceVoice(inProgress, { type: "activate" })).toBe(
                inProgress,
            );
        }
        const cancelled = reduceVoice(sessionIn("submitting"), {
            type: "cancel",
        });
        const restarted = reduceVoice(cancelled, { type: "activate" });
        expect(restarted.state).toBe("listening");
        expect(restarted.sessionId).toBe(2);
    });
});

describe("timeouts and failures", () => {
    it("no-speech timeout returns to idle without an error", () => {
        const s = reduceVoice(sessionIn("listening"), {
            type: "noSpeech",
            sessionId: 1,
        });
        expect(s.state).toBe("idle");
        expect(s.error).toBeNull();
        expect(s.transcript).toBeNull();
    });

    it("also honors no-speech while decoding", () => {
        const s = reduceVoice(sessionIn("transcribing"), {
            type: "noSpeech",
            sessionId: 1,
        });
        expect(s.state).toBe("idle");
    });

    it("transcript failure ends the session with the error recorded", () => {
        const s = reduceVoice(sessionIn("transcribing"), {
            type: "transcriptFailed",
            sessionId: 1,
            error: { code: "engine", message: "recognizer crashed" },
        });
        expect(s.state).toBe("idle");
        expect(s.error).toEqual({
            code: "engine",
            message: "recognizer crashed",
        });
        expect(s.transcript).toBeNull();
    });

    it("a rejected prompt ends the turn with the error, keeping the transcript", () => {
        for (const state of [
            "submitting",
            "waiting",
            "responding",
            "speaking",
        ] as const) {
            const before = sessionIn(state);
            const s = reduceVoice(before, {
                type: "rejected",
                sessionId: 1,
                error: { code: "rejected", message: "turn busy" },
            });
            expect(s.state).toBe("idle");
            expect(s.error).toEqual({ code: "rejected", message: "turn busy" });
            expect(s.transcript).toBe("hello");
        }
    });
});

describe("cancellation", () => {
    it("returns every active state to idle", () => {
        for (const state of [
            "listening",
            "transcribing",
            "submitting",
            "waiting",
            "responding",
            "speaking",
        ] as const) {
            const before = sessionIn(state);
            const s = reduceVoice(before, { type: "cancel" });
            expect(s.state).toBe("idle");
            expect(s.partial).toBeNull();
            expect(s.sessionId).toBe(before.sessionId);
        }
    });

    it("is a no-op in idle", () => {
        expect(reduceVoice(initialVoiceSnapshot, { type: "cancel" })).toBe(
            initialVoiceSnapshot,
        );
    });
});

describe("barge-in", () => {
    it("starts a new session from any active-response state", () => {
        for (const state of ["waiting", "responding", "speaking"] as const) {
            const interrupted = run(sessionIn(state), { type: "userSpeech" });
            expect(interrupted.state).toBe("listening");
            expect(interrupted.sessionId).toBe(2);
            expect(interrupted.transcript).toBeNull();
            expect(interrupted.partial).toBeNull();
            expect(interrupted.error).toBeNull();
        }
    });

    it("is ignored outside an active response", () => {
        for (const state of [
            "idle",
            "listening",
            "transcribing",
            "submitting",
        ] as const) {
            const before = sessionIn(state);
            expect(reduceVoice(before, { type: "userSpeech" })).toBe(before);
        }
    });
});

describe("stale-session isolation", () => {
    it("ignores events tagged with a different session id", () => {
        for (const event of [
            { type: "partial", sessionId: 7, text: "stale" },
            { type: "endOfSpeech", sessionId: 7 },
            { type: "noSpeech", sessionId: 7 },
            { type: "transcript", sessionId: 7, text: "stale" },
            {
                type: "transcriptFailed",
                sessionId: 7,
                error: { code: "aborted", message: "old" },
            },
            { type: "submitted", sessionId: 7 },
            {
                type: "rejected",
                sessionId: 7,
                error: { code: "aborted", message: "old" },
            },
            { type: "responseStarted", sessionId: 7 },
            { type: "audioStarted", sessionId: 7 },
            { type: "responseEnded", sessionId: 7 },
        ] as const) {
            const before = sessionIn("listening");
            const s = reduceVoice(before, event);
            expect(s).toBe(before);
        }
    });

    it("a dying generation never disturbs the barge-in session that replaced it", () => {
        let s = sessionIn("responding");
        s = reduceVoice(s, { type: "userSpeech" });
        expect(s.state).toBe("listening");
        expect(s.sessionId).toBe(2);

        expect(reduceVoice(s, { type: "responseEnded", sessionId: 1 })).toBe(s);
        expect(
            reduceVoice(s, { type: "transcript", sessionId: 1, text: "stale" }),
        ).toBe(s);
        expect(
            reduceVoice(s, { type: "partial", sessionId: 1, text: "stale" }),
        ).toBe(s);

        s = reduceVoice(s, {
            type: "transcript",
            sessionId: 2,
            text: "Paris, Texas",
        });
        expect(s.state).toBe("submitting");
        expect(s.transcript).toBe("Paris, Texas");
    });

    it("a completed session cannot be revived by late events", () => {
        const s = run(sessionIn("speaking"), {
            type: "responseEnded",
            sessionId: 1,
        });
        expect(s.state).toBe("idle");
        expect(
            reduceVoice(s, { type: "partial", sessionId: 1, text: "stale" }),
        ).toBe(s);
        expect(reduceVoice(s, { type: "audioStarted", sessionId: 1 })).toBe(s);
        expect(reduceVoice(s, { type: "responseEnded", sessionId: 1 })).toBe(s);
    });
});

describe("partial transcripts", () => {
    it("are recorded only while decoding, and cleared on transition", () => {
        let s = run(initialVoiceSnapshot, { type: "activate" });
        s = reduceVoice(s, { type: "partial", sessionId: 1, text: "what" });
        expect(s.partial).toBe("what");

        s = run(s, { type: "partial", sessionId: 1, text: "what time" });
        expect(s.partial).toBe("what time");

        s = reduceVoice(s, {
            type: "partial",
            sessionId: 1,
            text: "what time is it",
        });
        expect(s.partial).toBe("what time is it");

        s = reduceVoice(s, { type: "endOfSpeech", sessionId: 1 });
        expect(s.state).toBe("transcribing");
        expect(s.partial).toBeNull();

        s = reduceVoice(s, {
            type: "partial",
            sessionId: 1,
            text: "what time is it in",
        });
        expect(s.partial).toBe("what time is it in");

        s = reduceVoice(s, {
            type: "transcript",
            sessionId: 1,
            text: "what time is it in paris",
        });
        expect(s.state).toBe("submitting");
        expect(s.partial).toBeNull();
    });

    it("are ignored once the transcript is submitted", () => {
        const before = sessionIn("waiting");
        const s = reduceVoice(before, {
            type: "partial",
            sessionId: 1,
            text: "late",
        });
        expect(s).toBe(before);
    });
});
