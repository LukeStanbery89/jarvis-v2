/**
 * Shared provider-scaffolding tests (issue #107 P2).
 *
 * The helpers in `src/providers/internal.ts` were previously hand-copied
 * across the four browser providers; these tests pin their contracts
 * directly. Browser APIs are installed on `globalThis` per test (the same
 * approach as the provider suites) — no real microphone, Web Audio, or
 * clock is involved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    findAudioContextCtor,
    findUserMedia,
    isPermissionDenied,
    micError,
    openMicContext,
    releaseStream,
    voiceError,
    wireTrackEnded,
    type MediaStreamLike,
} from "../src/providers/internal";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("findUserMedia", () => {
    it("returns a bound getUserMedia when the browser offers one", () => {
        const getUserMedia = vi.fn();
        vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
        const found = findUserMedia();
        // The browser requires the mediaDevices receiver as `this`, so the
        // helper hands back a bound function, not the detached original.
        expect(found).not.toBeNull();
        expect(found).not.toBe(getUserMedia);
        void found!({ audio: { echoCancellation: true } });
        expect(getUserMedia).toHaveBeenCalledOnce();
    });

    it("returns null without a navigator or mediaDevices", () => {
        vi.stubGlobal("navigator", undefined);
        expect(findUserMedia()).toBeNull();
    });

    it("returns null when mediaDevices lacks getUserMedia", () => {
        vi.stubGlobal("navigator", { mediaDevices: {} });
        expect(findUserMedia()).toBeNull();
    });
});

describe("findAudioContextCtor", () => {
    it("prefers the standard constructor and falls back to webkit", () => {
        class Standard {}
        class Webkit {}
        vi.stubGlobal("AudioContext", Standard);
        vi.stubGlobal("webkitAudioContext", Webkit);
        expect(findAudioContextCtor<object>()).toBe(Standard);
        vi.stubGlobal("AudioContext", undefined);
        expect(findAudioContextCtor<object>()).toBe(Webkit);
    });

    it("returns null where Web Audio is unavailable", () => {
        vi.stubGlobal("AudioContext", undefined);
        vi.stubGlobal("webkitAudioContext", undefined);
        expect(findAudioContextCtor<object>()).toBeNull();
    });
});

describe("releaseStream", () => {
    it("stops every track and detaches the ended handler", () => {
        const onended = vi.fn();
        const track = { stop: vi.fn(), onended };
        releaseStream({
            getTracks: () => [track],
        } as unknown as MediaStreamLike);
        expect(track.onended).toBeNull();
        expect(track.stop).toHaveBeenCalledOnce();
    });

    it("ignores a null stream and a throwing stop", () => {
        expect(() => releaseStream(null)).not.toThrow();
        expect(() =>
            releaseStream({
                getTracks: () => [
                    {
                        onended: null,
                        stop: () => {
                            throw new Error("already dead");
                        },
                    },
                ],
            } as unknown as MediaStreamLike),
        ).not.toThrow();
    });
});

describe("voiceError", () => {
    it("builds the { code, message } shape", () => {
        expect(voiceError("engine", "boom")).toEqual({
            code: "engine",
            message: "boom",
        });
    });
});

describe("isPermissionDenied / micError", () => {
    it("matches permission-shaped messages case-insensitively", () => {
        expect(isPermissionDenied(new Error("Permission dismissed"))).toBe(
            true,
        );
        expect(
            isPermissionDenied(new Error("Requested device not allowed")),
        ).toBe(true);
        expect(isPermissionDenied(new Error("network offline"))).toBe(false);
        expect(isPermissionDenied("not an error")).toBe(false);
    });

    it("maps a permission message to permission-denied", () => {
        expect(micError(new Error("permission denied"), "fallback")).toEqual({
            code: "permission-denied",
            message: "permission denied",
        });
    });

    it("maps other Errors to engine with their message", () => {
        expect(micError(new Error("context failed"), "fallback")).toEqual({
            code: "engine",
            message: "context failed",
        });
    });

    it("uses the fallback message for a non-Error rejection", () => {
        expect(micError(42, "could not open the microphone")).toEqual({
            code: "engine",
            message: "could not open the microphone",
        });
    });
});

describe("openMicContext", () => {
    it("returns the stream and a fresh context on success", async () => {
        const stream = { getTracks: () => [] } as unknown as MediaStreamLike;
        const getUserMedia = vi.fn(async () => stream);
        class Context {}
        const capture = await openMicContext(getUserMedia, Context, "fallback");
        expect(getUserMedia).toHaveBeenCalledWith({
            audio: { echoCancellation: true },
        });
        expect(capture.stream).toBe(stream);
        expect(capture.context).toBeInstanceOf(Context);
    });

    it("maps the error when the mic is denied (no stream exists to release)", async () => {
        const getUserMedia = vi.fn(async () => {
            throw new Error("Permission denied by user agent");
        });
        await expect(
            openMicContext(getUserMedia, class {}, "fallback"),
        ).rejects.toEqual({
            code: "permission-denied",
            message: "Permission denied by user agent",
        });
        expect(getUserMedia).toHaveBeenCalledOnce();
    });

    it("releases the stream when the context constructor throws", async () => {
        const track = { onended: null, stop: vi.fn() };
        const stream = {
            getTracks: () => [track],
        } as unknown as MediaStreamLike;
        const getUserMedia = vi.fn(async () => stream);
        class Context {
            constructor() {
                throw new Error("no web audio");
            }
        }
        await expect(
            openMicContext(getUserMedia, Context, "fallback"),
        ).rejects.toEqual({ code: "engine", message: "no web audio" });
        expect(track.stop).toHaveBeenCalledOnce();
    });
});

describe("wireTrackEnded", () => {
    it("wires the first track's onended handler", () => {
        const onended = vi.fn();
        const track: { onended: (() => void) | null } = { onended: null };
        wireTrackEnded(
            { getTracks: () => [track] } as unknown as MediaStreamLike,
            onended,
        );
        expect(track.onended).toBe(onended);
    });

    it("does nothing on a trackless stream", () => {
        expect(() =>
            wireTrackEnded(
                { getTracks: () => [] } as unknown as MediaStreamLike,
                vi.fn(),
            ),
        ).not.toThrow();
    });
});
