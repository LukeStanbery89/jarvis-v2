/**
 * Engine-selection ordering for the chat client's mic (`createStt`).
 *
 * The selector must prefer Web Speech — it is the fast, cloud-backed path
 * in Chrome and the UX users expect — and only fall back to the local WASM
 * engine (Vosk, #84 P3b) when no `SpeechRecognition` exists. These tests
 * pin that order, not either engine's internals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStt } from "./voice";

/** A constructor double sufficient for the Web Speech availability gate. */
class FakeRecognition {}

/** A constructor double sufficient for the WASM engine's AudioContext gate. */
class FakeAudioContext {}

afterEach(() => {
    vi.unstubAllGlobals();
});

/** Raw Node is a support vacuum: gate both engines off. */
function stripAll(): void {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    vi.stubGlobal(
        "navigator",
        // A bare object without `mediaDevices` satisfies the vulnerability
        // surface Node leaves here.
        {},
    );
}

/** Grant Web Speech only. */
function grantWebSpeech(): void {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
}

/** Grant the Vosk engine only (media devices + Web Audio; Node has Wasm). */
function grantVosk(): void {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("navigator", {
        mediaDevices: {
            // Not called by the selector — presence is the gate.
            getUserMedia: () => Promise.reject(new Error("unused")),
        },
    });
}

describe("createStt engine selection", () => {
    it("returns null when no engine is available", () => {
        stripAll();
        expect(createStt()).toBeNull();
    });

    it("prefers Web Speech when both engines are available", () => {
        stripAll();
        grantWebSpeech();
        grantVosk();
        expect(createStt()?.id).toBe("web-speech");
    });

    it("uses Web Speech alone when it is the only engine", () => {
        stripAll();
        grantWebSpeech();
        expect(createStt()?.id).toBe("web-speech");
    });

    it("falls back to the local WASM engine when Web Speech is absent", () => {
        stripAll();
        grantVosk();
        expect(createStt()?.id).toBe("vosk-wasm");
    });
});
