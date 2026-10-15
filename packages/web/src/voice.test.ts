/**
 * Engine-selection ordering for the chat client's mic (`createStt`).
 *
 * The selector must prefer Web Speech — it is the fast, cloud-backed path
 * in Chrome and the UX users expect — and only fall back to the local WASM
 * engine (Vosk, #84 P3b) when no `SpeechRecognition` exists. These tests
 * pin that order, not either engine's internals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenWakeWord } from "@lukestanbery/jarvis-voice";
import {
    createStt,
    createWakeStt,
    createWakeWord,
    probeWakeSupport,
    readWakePref,
    wakeAssetBaseUrl,
    wakeWasmPath,
    writeWakePref,
} from "./voice";

// The detector's *options* are unreachable in this node environment
// (createOpenWakeWord returns null before it uses them), so the seam is
// mocked to observe what `createWakeWord` actually passes — the call site is
// what #123 broke. Everything else stays real.
vi.mock("@lukestanbery/jarvis-voice", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@lukestanbery/jarvis-voice")>();
    return { ...actual, createOpenWakeWord: vi.fn(() => null) };
});

/** A constructor double sufficient for the Web Speech availability gate. */
class FakeRecognition {}

/** A constructor double sufficient for the WASM engine's AudioContext gate. */
class FakeAudioContext {}

// The dev server serves the staged assets from the page's own origin (Vite
// serves `publicDir` under `base`), which is the case #123 fixes. The `/web/`
// path matches production; the unit tests below pass an explicit base, so the
// origin's own path never matters.
const DEV_ORIGIN = "http://localhost:5173/web/";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
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
        // Wake sessions get the on-device engine so the detector's audio never
        // leaves the browser (#84 P4).
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

describe("wakeWasmPath", () => {
    it("resolves the staged directory against the page origin", () => {
        expect(wakeWasmPath("/web/ort/", DEV_ORIGIN)).toBe(
            "http://localhost:5173/web/ort/",
        );
    });

    it("never returns a document-relative path", () => {
        // The load-bearing property. Vite's dev server rewrites ORT's
        // non-analyzable `import(<url>)` to append `?import`, but its
        // `__vite__injectQuery` helper returns any specifier that does not
        // start with "." or "/" untouched; a relative directory would be
        // queried and then refused as a public/ asset (#123).
        expect(wakeWasmPath("/web/ort/", DEV_ORIGIN).startsWith("/")).toBe(
            false,
        );
    });

    it("resolves a root-relative base against the origin, not its path", () => {
        expect(wakeWasmPath("/web/ort/", "http://localhost:5173/other/")).toBe(
            "http://localhost:5173/web/ort/",
        );
    });

    it("leaves an already-absolute directory alone", () => {
        expect(wakeWasmPath("https://jarvis.local/web/ort/", DEV_ORIGIN)).toBe(
            "https://jarvis.local/web/ort/",
        );
    });
});

describe("createWakeWord", () => {
    it("hands ORT an absolute directory and the worklet a relative one", () => {
        // The wiring #123 broke: `wasmPath` must be origin-absolute, while the
        // worklet URL stays document-relative, because
        // `audioWorklet.addModule` is the one load the dev server never
        // rewrites.
        vi.stubGlobal("location", { href: DEV_ORIGIN });

        createWakeWord();

        const options = vi.mocked(createOpenWakeWord).mock.lastCall?.[0];
        // Origin-absolute: that is the whole point — the dev server appends its
        // `?import` query only to specifiers beginning with "." or "/". The
        // expected value is built from `wakeAssetBaseUrl()`, which derives from
        // Vite's `BASE_URL` — `/web/` under `vite.config.ts`, but `/` here,
        // since `vitest.config.ts` sets no `base` for this node-env suite.
        expect(options?.wasmPath).toBe(
            `http://localhost:5173${wakeAssetBaseUrl()}`,
        );
        expect(options?.wasmPath?.startsWith("/")).toBe(false);
        expect(options?.workletUrl?.startsWith("/")).toBe(true);
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
