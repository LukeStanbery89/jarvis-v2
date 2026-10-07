/**
 * STT engine selection tests (issue #84, phase 3b).
 *
 * `createStt` is the web client's one engine-local decision: the local WASM
 * engine (Vosk) first, Web Speech as the fallback, `null` when neither is
 * available. The probes read `globalThis`, so node tests stub the pieces
 * (`navigator.mediaDevices`, `AudioContext`, `SpeechRecognition`) to walk
 * the chain deterministically; node itself already carries `WebAssembly`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    VoskSttProvider,
    WebSpeechSttProvider,
} from "@lukestanbery/jarvis-voice";
import { createStt } from "./voice";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("createStt engine selection", () => {
    it("returns null when no engine is available (bare node)", () => {
        expect(createStt()).toBeNull();
    });

    it("selects the local WASM engine when mic + Web Audio exist", () => {
        vi.stubGlobal("navigator", {
            mediaDevices: { getUserMedia: () => Promise.resolve({}) },
        });
        vi.stubGlobal("AudioContext", class FakeAudioContext {});
        expect(createStt()).toBeInstanceOf(VoskSttProvider);
    });

    it("falls back to Web Speech when the WASM stack is unavailable", () => {
        vi.stubGlobal("navigator", {});
        vi.stubGlobal("AudioContext", undefined);
        vi.stubGlobal("SpeechRecognition", class FakeRecognition {});
        expect(createStt()).toBeInstanceOf(WebSpeechSttProvider);
    });

    it("returns null when neither engine is available", () => {
        vi.stubGlobal("navigator", {});
        vi.stubGlobal("AudioContext", undefined);
        expect(createStt()).toBeNull();
    });

    it("passes the model URL override to the WASM engine", () => {
        vi.stubGlobal("navigator", {
            mediaDevices: { getUserMedia: () => Promise.resolve({}) },
        });
        vi.stubGlobal("AudioContext", class FakeAudioContext {});
        const provider = createStt({ modelUrl: "/models/stt/model.tar.gz" });
        expect(provider).toBeInstanceOf(VoskSttProvider);
    });
});
