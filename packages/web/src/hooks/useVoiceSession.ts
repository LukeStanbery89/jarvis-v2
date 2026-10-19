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
    type VoiceState,
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
 * The voice line the app renders (#90 phase 6d): the stage, or "Speaking…".
 *
 * {@link voiceStatusText} plus the one case that needs the player: a reply whose
 * audio is still scheduled reads as speaking even though the lifecycle has left
 * `speaking` (the `done` frame arrives while seconds of speech are queued). Two
 * surfaces render this — the chat's status line and the bar's microphone chip —
 * so the sentence has one home instead of two that can disagree.
 *
 * @param snapshot - The current voice snapshot.
 * @param playbackActive - Whether the player still has scheduled audio.
 * @returns The line, or `null` when there is nothing to say.
 */
export function voiceStatusLine(
    snapshot: VoiceSnapshot,
    playbackActive: boolean,
): string | null {
    if (snapshot.state === "speaking" || playbackActive) {
        return "Speaking…";
    }
    return voiceStatusText(snapshot);
}

/**
 * Whether the barge-in watch covers a voice lifecycle state (#114).
 *
 * `responding` onward, **not just `speaking`**. `speaking` is entered by the
 * `audioStart` frame, so keying the watch on it left everything before the
 * first audio frame with no microphone listener at all. A tool turn reaches
 * `responding` when the model *requests* the tool — the server announces
 * `tool` while streaming the call, before it runs — so for a weather answer
 * the whole tool round trip plus the first segment's synthesis was a dead
 * zone: a "Hey JARVIS" said into that silence did nothing, and playback then
 * started and ran on. Arming from the response's first frame closes it.
 *
 * `playbackActive` extends the window the other way, past the turn: the
 * lifecycle leaves `speaking` when the turn's `done` frame arrives
 * (`responseEnded`), while the player still has seconds of speech scheduled.
 * Without it the watch disarms mid-answer and talking over the tail of a
 * reply does nothing — the behaviour that made barge-in work "sometimes"
 * depending on where in the answer the user spoke.
 *
 * Deliberately a boolean rather than the state itself: the caller keys its
 * effect on this value, so the watch is armed once per window instead of
 * being torn down and re-armed on the `responding` → `speaking` step (which
 * would reopen the microphone mid-turn).
 *
 * @param state - The voice lifecycle state to test.
 * @param playbackActive - Whether the player still has scheduled audio.
 * @returns Whether the barge-in watch should be armed.
 */
export function watchBargeIn(
    state: VoiceState,
    playbackActive = false,
): boolean {
    return playbackActive || state === "responding" || state === "speaking";
}

/**
 * Owns the voice stack for the chat view.
 *
 * @param options.submit - Submits a final transcript (a stable wrapper over the
 *   chat view's latest turn runner).
 * @param options.onWakeCue - A cue to play when the wake phrase matches.
 * @param options.onBargeIn - The barge-in trigger (stop playback + cancel).
 * @param options.playbackActive - Whether the player still has scheduled audio
 *   (keeps the barge watch armed through the reply's audio tail, #114).
 * @param options.engineAssets - The WASM engine's worker/WASM URLs.
 * @returns The controller, snapshot, derived view state, and the toggles.
 */
export function useVoiceSession(options: {
    submit(text: string): Promise<void>;
    onWakeCue(): void;
    onBargeIn(): void;
    /**
     * Whether the player still has scheduled, audible audio for the last
     * reply (#114). The reply's audio outlives its `done` frame, so the barge
     * watch stays armed on this even once the lifecycle is back to `idle`.
     * The player reports `false` while its context cannot play (a suspended
     * or interrupted `AudioContext` never lets its sources end), so this
     * cannot latch true and hold the watch open indefinitely.
     */
    playbackActive?: boolean;
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

    // Barge-in watch (#84 P6, covering the whole reply since #114): while a
    // voice answer streams and plays, a VAD-only mic session listens for the
    // user talking over it — sustained speech stops local playback, cancels the
    // in-flight turn, and opens a listening session seeded with the interrupted
    // opening. Armed from the response's first frame, and held through the
    // audio tail after the turn's `done` (`playbackActive`), so a long tool turn
    // and a reply that outlives its frames are both covered (see `watchBargeIn`);
    // keyed on the boolean so the microphone opens once per window. Arming
    // failures are silent by design — the controller's log carries what it can
    // (see `BargeWatch`).
    const bargeWindow = watchBargeIn(
        snapshot.state,
        options.playbackActive === true,
    );
    useEffect(() => {
        if (controller === null || !bargeWindow) {
            return;
        }
        void controller.startBargeWatch();
        return () => {
            void controller.stopBargeWatch();
        };
    }, [controller, bargeWindow]);

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
