/**
 * Voice-session hook for the chat view (#84).
 *
 * Owns the browser's STT/VAD/wake engines (render-refs, recoverable providers)
 * and one {@link VoiceController} constructed **inside a mount effect**, so a
 * StrictMode double-invoke gets a fresh controller over the same engines instead
 * of a disposed one (the latent dev bug: wake + barge-in died after the
 * simulated unmount). The controller is the external store; React renders from
 * its snapshot via `useSyncExternalStore`.
 *
 * Also holds the wake/support probe, the arm/disarm effect, the barge-in watch,
 * and the pure {@link voiceStatusText} derivation the view renders.
 */
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import {
    createBrowserVad,
    initialVoiceSnapshot,
    type SttProvider,
    type VadProvider,
    type VoiceSnapshot,
    type WakeWordProvider,
} from "@lukestanbery/jarvis-voice";
import {
    createStt,
    createWakeStt,
    createWakeWord,
    probeWakeSupport,
    readWakePref,
    VoiceController,
    writeWakePref,
} from "../voice";
// The local speech engine's worker + WASM binary are served as same-origin
// assets via the Vite build (`?url` copies them into dist and yields their
// URLs); the library's own default paths cannot resolve from a /web mount.
import voskWorkerUrl from "@lichess-org/vosk-browser/dist/vosk.worker.js?url";
import voskWasmUrl from "@lichess-org/vosk-browser/dist/vosk.wasm?url";
import { debugLog } from "../debug";
import { voiceTrace } from "../voiceTrace";

/** The voice stack's debug sink: `jarvis.debug`-gated console lines. */
const debugVoice = (message: string, error?: unknown): void =>
    debugLog("voice", message, error);

/** The public surface {@link useVoiceSession} returns. */
export interface UseVoiceSessionResult {
    /** The controller, or `null` before the mount effect runs (or no STT). */
    voice: VoiceController | null;
    /** The voice lifecycle snapshot. */
    snapshot: VoiceSnapshot;
    /** Whether an STT engine exists (render-known — the mic never flashes). */
    sttAvailable: boolean;
    /** Local wake engines exist and the server serves the model. */
    wakeAvailable: boolean;
    /** The wake-word preference (persisted). */
    wakeOn: boolean;
    /** The controller is actively listening for the wake phrase. */
    wakeArmed: boolean;
    /** Whether the server answers the wake-model probe. */
    wakeServerReady: boolean;
    /** A voice session that ended in failure (kept until the next press). */
    voiceErrorText: string | null;
    /** The voice turn is mid-flight (the mic rests until it settles). */
    voiceTurnInFlight: boolean;
    /** Starts/stops a voice session (the mic press). */
    press(): void;
    /** Flips the wake toggle, persists it, and returns the new value. */
    toggleWake(): boolean;
}

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

/**
 * Owns the voice stack for the chat view.
 *
 * @param options.submit - Submits a final transcript (a stable wrapper over the
 *   chat view's latest turn runner).
 * @param options.onWakeCue - A cue to play when the wake phrase matches.
 * @param options.onBargeIn - The barge-in trigger (stop playback + cancel).
 * @param options.engineAssets - The WASM engine's worker/WASM URLs.
 * @returns The controller, snapshot, derived view state, and the toggles.
 */
export function useVoiceSession(options: {
    submit(text: string): Promise<void>;
    onWakeCue(): void;
    onBargeIn(): void;
    engineAssets?: { workerUrl: string; wasmUrl: string };
}): UseVoiceSessionResult {
    const { workerUrl = voskWorkerUrl, wasmUrl = voskWasmUrl } =
        options.engineAssets ?? {};

    // Engines are render-refs, created once per mount (recoverable providers):
    // `sttAvailable` is therefore render-known and the mic button never flashes.
    const sttRef = useRef<SttProvider | null>(null);
    if (sttRef.current === null) {
        sttRef.current = createStt({ workerUrl, wasmUrl, log: debugVoice });
    }
    const stt = sttRef.current;
    const vadRef = useRef<VadProvider | null>(null);
    if (vadRef.current === null) {
        vadRef.current = createBrowserVad();
    }
    const vad = vadRef.current;
    const wakeSttRef = useRef<SttProvider | null>(null);
    if (wakeSttRef.current === null) {
        wakeSttRef.current = createWakeStt({
            workerUrl,
            wasmUrl,
            log: debugVoice,
        });
    }
    const wakeStt = wakeSttRef.current;
    const wakeRef = useRef<WakeWordProvider | null>(null);
    if (wakeRef.current === null) {
        wakeRef.current = createWakeWord({ log: debugVoice });
    }
    const wake = wakeRef.current;

    const [wakeOn, setWakeOn] = useState(() => readWakePref(localStorage));
    const [wakeServerReady, setWakeServerReady] = useState(false);

    // Latest props: the controller is constructed once, so its closures must
    // always read the current render's callbacks.
    const submitRef = useRef(options.submit);
    submitRef.current = options.submit;
    const onWakeCueRef = useRef(options.onWakeCue);
    onWakeCueRef.current = options.onWakeCue;
    const onBargeInRef = useRef(options.onBargeIn);
    onBargeInRef.current = options.onBargeIn;

    // Construct in the mount effect (StrictMode fix); mirror to state so the
    // external-store subscription re-binds when the controller swaps.
    const controllerRef = useRef<VoiceController | null>(null);
    const [controller, setController] = useState<VoiceController | null>(null);
    useEffect(() => {
        if (stt === null) {
            return;
        }
        const instance = new VoiceController({
            stt,
            vad,
            wake,
            wakeStt,
            log: debugVoice,
            // Raw vs submitted (#121): a separate, opt-in sink because it
            // prints real speech — see src/voiceTrace.ts.
            traceTranscript: (raw, submitted) => voiceTrace(raw, submitted),
            submit: (text) => submitRef.current(text),
            onWakeCue: () => onWakeCueRef.current(),
            onBargeIn: () => onBargeInRef.current(),
        });
        controllerRef.current = instance;
        setController(instance);
        return () => {
            controllerRef.current = null;
            setController(null);
            void instance.dispose();
        };
    }, [stt, vad, wake, wakeStt]);

    // The controller is the external store; the view renders from its snapshot.
    const subscribe = useCallback(
        (onStoreChange: () => void) =>
            controller?.subscribe(onStoreChange) ?? (() => undefined),
        [controller],
    );
    const getSnapshot = useCallback(
        () => controller?.getSnapshot() ?? initialVoiceSnapshot,
        [controller],
    );
    const snapshot = useSyncExternalStore(subscribe, getSnapshot);

    // Wake-word support probe (#84 P4): one HEAD to the wake model route.
    // A configured server answers 200; an unconfigured one 404s without
    // downloading anything (HEAD). Failure just keeps the toggle hidden.
    useEffect(() => {
        let cancelled = false;
        void probeWakeSupport().then((ok) => {
            if (!cancelled) {
                setWakeServerReady(ok);
            }
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // Arm/disarm the detector with the sidebar toggle. `enableWake` is a
    // silent no-op when the engines are missing, so the guard is a nicety.
    const wakeAvailable = wake !== null && wakeStt !== null && wakeServerReady;
    useEffect(() => {
        if (controller === null) {
            return;
        }
        if (wakeAvailable && wakeOn) {
            void controller.enableWake();
        } else {
            void controller.disableWake();
        }
    }, [controller, wakeAvailable, wakeOn]);

    // Barge-in watch (#84 P6): while J.A.R.V.I.S. is speaking, a VAD-only mic
    // session listens for the user talking over the reply — sustained speech
    // stops local playback, cancels the in-flight turn, and opens a listening
    // session seeded with the interrupted opening. The watch lives exactly as
    // long as playback; arming failures are silent by design.
    useEffect(() => {
        if (controller === null || snapshot.state !== "speaking") {
            return;
        }
        void controller.startBargeWatch();
        return () => {
            void controller.stopBargeWatch();
        };
    }, [controller, snapshot.state]);

    const press = useCallback((): void => {
        controllerRef.current?.press();
    }, []);

    const toggleWake = useCallback((): boolean => {
        const next = !wakeOn;
        setWakeOn(next);
        writeWakePref(localStorage, next);
        return next;
    }, [wakeOn]);

    const voiceTurnInFlight =
        snapshot.state === "submitting" ||
        snapshot.state === "waiting" ||
        snapshot.state === "responding" ||
        snapshot.state === "speaking";
    const voiceErrorText =
        snapshot.state === "idle" ? (snapshot.error?.message ?? null) : null;

    return {
        voice: controller,
        snapshot,
        sttAvailable: stt !== null,
        wakeAvailable,
        wakeOn,
        wakeArmed: snapshot.wakeArmed,
        wakeServerReady,
        voiceErrorText,
        voiceTurnInFlight,
        press,
        toggleWake,
    };
}
