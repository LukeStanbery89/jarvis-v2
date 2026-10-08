/**
 * Engine-selection ordering for the chat client's mic (`createStt`).
 *
 * The selector must prefer Web Speech — it is the fast, cloud-backed path
 * in Chrome and the UX users expect — and only fall back to the local WASM
 * engine (Vosk, #84 P3b) when no `SpeechRecognition` exists. These tests
 * pin that order, not either engine's internals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createStt,
    createWakeStt,
    probeWakeSupport,
    readWakePref,
    wakeAssetBaseUrl,
    writeWakePref,
} from "./voice";

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

describe("createWakeStt", () => {
    it("always uses the local WASM engine, never Web Speech", () => {
        // Wake sessions get the on-device engine so the detector's look-back
        // audio never leaves the browser (#84 P4).
        stripAll();
        grantVosk();
        expect(createWakeStt()?.id).toBe("vosk-wasm");
    });

    it("returns null when the WASM engine is unavailable", () => {
        stripAll();
        expect(createWakeStt()).toBeNull();
    });
});

describe("wakeAssetBaseUrl", () => {
    it("derives the ort/ directory from the app base", () => {
        // The `/web` mount both dev and the production static host agree on.
        expect(wakeAssetBaseUrl("/web/")).toBe("/web/ort/");
        expect(wakeAssetBaseUrl("/web")).toBe("/web/ort/");
    });

    it("accepts an origin-qualified base", () => {
        expect(wakeAssetBaseUrl("https://jarvis.local/web/")).toBe(
            "https://jarvis.local/web/ort/",
        );
    });
});

describe("wake preference", () => {
    /** A bare localStorage-shaped fake. */
    function fakeStorage(): { store: Map<string, string> } & Storage {
        const store = new Map<string, string>();
        return {
            store,
            getItem: (k) => store.get(k) ?? null,
            setItem: (k, v) => void store.set(k, v),
            removeItem: (k) => void store.delete(k),
            clear: () => store.clear(),
            key: (i) => [...store.keys()][i] ?? null,
            get length() {
                return store.size;
            },
        };
    }

    it("defaults to off (wake opens a persistent second mic)", () => {
        const storage = fakeStorage();
        expect(readWakePref(storage)).toBe(false);
    });

    it("round-trips an explicit on/off choice", () => {
        const storage = fakeStorage();
        writeWakePref(storage, true);
        expect(readWakePref(storage)).toBe(true);
        writeWakePref(storage, false);
        expect(readWakePref(storage)).toBe(false);
    });
});

describe("probeWakeSupport", () => {
    it("reports configured when the server answers the HEAD probe", async () => {
        const fetchFn = vi.fn(
            async () => new Response(null, { status: 200 }),
        ) as unknown as typeof fetch;
        await expect(probeWakeSupport(fetchFn)).resolves.toBe(true);
        expect(fetchFn).toHaveBeenCalledWith(
            "/api/wake/model/melspectrogram.onnx",
            { method: "HEAD" },
        );
    });

    it("reports unconfigured on a non-OK probe (incl. server 404s)", async () => {
        const fetchFn = vi.fn(
            async () => new Response(null, { status: 404 }),
        ) as unknown as typeof fetch;
        await expect(probeWakeSupport(fetchFn)).resolves.toBe(false);
    });

    it("reports unconfigured when the probe itself fails", async () => {
        const fetchFn = vi.fn(async () => {
            throw new Error("network down");
        }) as unknown as typeof fetch;
        await expect(probeWakeSupport(fetchFn)).resolves.toBe(false);
    });
});
