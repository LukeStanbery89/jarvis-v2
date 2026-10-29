/**
 * Satellite configuration.
 *
 * Everything the daemon needs is environment-driven so a systemd unit or a
 * launchd plist can carry it without a config parser. The defaults target a
 * Mac talking to the local TLS dev server; a Raspberry Pi deployment overrides
 * `JARVIS_SERVER_URL` and the audio device/tool paths.
 */
import { homedir } from "node:os";
import path from "node:path";

/** The sample rate used by the wake/STT path and sent to Whisper. */
export const SAMPLE_RATE = 16_000;

/** The default server WebSocket, matching the TLS dev server. */
const DEFAULT_SERVER_URL = "wss://localhost:54321/ws";

/** The default local STT model; the tiny English model is the Pi-friendly one. */
const DEFAULT_STT_MODEL = "onnx-community/whisper-tiny.en";

export interface SatelliteConfig {
    /** The `/ws` endpoint, `ws://` or `wss://`. */
    readonly serverUrl: string;
    /** Disable certificate verification for a local self-signed server. */
    readonly insecureTls: boolean;
    /** Optional CA bundle for a private server certificate. */
    readonly caPath: string | undefined;
    /** How long the socket may take to open. */
    readonly connectTimeoutMs: number;
    /** How long the server may take to answer the auth handshake. */
    readonly authTimeoutMs: number;
    /** Private state root (`~/.jarvis/satellite` by default). */
    readonly stateDir: string;
    /** SoX input device name; undefined uses the system default. */
    readonly inputDevice: string | undefined;
    /** Where the credential file lives; the CLI writes the same shape. */
    readonly credentialsFile: string;
    /** Persistent conversation id store. */
    readonly sessionFile: string;
    /** Optional fixed conversation id, overriding the store. */
    readonly sessionId: string | undefined;
    /** Where Transformers.js caches the local model. */
    readonly sttModel: string;
    /** Quantization: q8 is the default for a Pi. */
    readonly sttDtype: string;
    /** Transformers.js cache directory. */
    readonly modelCacheDir: string;
    /** SoX `silence` onset duration, seconds. */
    readonly onsetSeconds: number;
    /** SoX `silence` trailing-silence duration, seconds. */
    readonly silenceSeconds: number;
    /** SoX `silence` threshold, e.g. `1%`. */
    readonly silenceThreshold: string;
    /** Maximum length of one captured utterance, seconds. */
    readonly maxUtteranceSeconds: number;
    /** How long a push-to-talk capture may wait for speech before giving up. */
    readonly recordTimeoutMs: number;
    /** Delay after opening the PTT mic before cueing the user to speak. */
    readonly pttLeadMs: number;
    /** Normalized RMS threshold for the continuous wake capture. */
    readonly vadThreshold: number;
    /** Speech needed before the wake segmenter starts an utterance. */
    readonly vadOnsetMs: number;
    /** Silence that ends a wake utterance. */
    readonly vadSilenceMs: number;
    /** Audio retained before onset, so the wake phrase's first word survives. */
    readonly vadPreRollMs: number;
    /** Hard cap on one wake utterance. */
    readonly vadMaxUtteranceMs: number;
    /** Window in which a command may follow a wake-only utterance. */
    readonly wakeFollowUpMs: number;
    /** Window after a reply in which a follow-up needs no wake phrase; 0 disables. */
    readonly conversationFollowUpMs: number;
    /** Whether playback watches the microphone for a spoken interruption. */
    readonly bargeInEnabled: boolean;
    /** RMS threshold for a barge-in candidate; higher than the wake VAD. */
    readonly bargeInThreshold: number;
    /** Sustained speech needed before playback stops. */
    readonly bargeInMs: number;
    /** Audio kept before the barge-in trigger to seed the command. */
    readonly bargeInPreRollMs: number;
    /** Speak the reply locally when the server sent no audio (macOS `say`). */
    readonly localTts: boolean;
}

/** Reads a boolean env var, accepting the usual truthy spellings. */
function envBool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value.trim() === "") {
        return fallback;
    }
    return /^(1|true|yes|on)$/i.test(value.trim());
}

/** Reads a finite number env var with a lower bound. */
function envNumber(
    name: string,
    value: string | undefined,
    fallback: number,
    min: number,
): number {
    if (value === undefined || value.trim() === "") {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min) {
        throw new Error(`${name} must be a number >= ${min}`);
    }
    return parsed;
}

/** Returns the server origin used as a credential key. */
export function serverOrigin(serverUrl: string): string {
    const url = new URL(serverUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
        throw new Error("JARVIS_SERVER_URL must start with ws:// or wss://");
    }
    return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
}

/**
 * Credential keys to try for a server.
 *
 * The text CLI stores tokens under the HTTP(S) origin derived from its
 * WebSocket URL. A server that moved from HTTP to HTTPS (the local dev server
 * did) still has the old key, so try the alternate scheme before giving up.
 */
export function credentialOrigins(serverUrl: string): string[] {
    const origin = serverOrigin(serverUrl);
    const alternate = origin.startsWith("https://")
        ? `http://${origin.slice("https://".length)}`
        : `https://${origin.slice("http://".length)}`;
    return [origin, alternate];
}

/** Reads the environment into the daemon's configuration. */
export function loadConfig(
    env: NodeJS.ProcessEnv = process.env,
): SatelliteConfig {
    const serverUrl = env.JARVIS_SERVER_URL?.trim() || DEFAULT_SERVER_URL;
    // Validate eagerly so a typo fails at launch, not on the first wake.
    serverOrigin(serverUrl);

    const stateDir =
        env.JARVIS_SATELLITE_STATE_DIR?.trim() ||
        path.join(homedir(), ".jarvis", "satellite");
    const modelCacheDir =
        env.JARVIS_SATELLITE_MODEL_DIR?.trim() || path.join(stateDir, "models");
    const sessionId = env.JARVIS_SATELLITE_SESSION_ID?.trim() || undefined;
    if (sessionId !== undefined && sessionId.length > 128) {
        throw new Error(
            "JARVIS_SATELLITE_SESSION_ID must be at most 128 chars",
        );
    }

    return {
        serverUrl,
        insecureTls: envBool(env.JARVIS_SATELLITE_INSECURE_TLS, false),
        caPath: env.JARVIS_SATELLITE_CA?.trim() || undefined,
        connectTimeoutMs: envNumber(
            "JARVIS_SATELLITE_CONNECT_TIMEOUT_MS",
            env.JARVIS_SATELLITE_CONNECT_TIMEOUT_MS,
            5_000,
            100,
        ),
        authTimeoutMs: envNumber(
            "JARVIS_SATELLITE_AUTH_TIMEOUT_MS",
            env.JARVIS_SATELLITE_AUTH_TIMEOUT_MS,
            5_000,
            100,
        ),
        stateDir,
        inputDevice: env.JARVIS_SATELLITE_INPUT_DEVICE?.trim() || undefined,
        credentialsFile:
            env.JARVIS_CREDENTIALS_FILE?.trim() ||
            path.join(homedir(), ".jarvis", "credentials.json"),
        sessionFile:
            env.JARVIS_SATELLITE_SESSION_FILE?.trim() ||
            path.join(stateDir, "sessions.json"),
        sessionId,
        sttModel: env.JARVIS_SATELLITE_STT_MODEL?.trim() || DEFAULT_STT_MODEL,
        sttDtype: env.JARVIS_SATELLITE_STT_DTYPE?.trim() || "q8",
        modelCacheDir,
        onsetSeconds: envNumber(
            "JARVIS_SATELLITE_ONSET_SECONDS",
            env.JARVIS_SATELLITE_ONSET_SECONDS,
            0.3,
            0.05,
        ),
        silenceSeconds: envNumber(
            "JARVIS_SATELLITE_SILENCE_SECONDS",
            env.JARVIS_SATELLITE_SILENCE_SECONDS,
            0.9,
            0.2,
        ),
        silenceThreshold:
            env.JARVIS_SATELLITE_SILENCE_THRESHOLD?.trim() || "1%",
        maxUtteranceSeconds: envNumber(
            "JARVIS_SATELLITE_MAX_UTTERANCE_SECONDS",
            env.JARVIS_SATELLITE_MAX_UTTERANCE_SECONDS,
            12,
            1,
        ),
        recordTimeoutMs: envNumber(
            "JARVIS_SATELLITE_RECORD_TIMEOUT_MS",
            env.JARVIS_SATELLITE_RECORD_TIMEOUT_MS,
            20_000,
            1_000,
        ),
        pttLeadMs: envNumber(
            "JARVIS_SATELLITE_PTT_LEAD_MS",
            env.JARVIS_SATELLITE_PTT_LEAD_MS,
            600,
            0,
        ),
        vadThreshold: envNumber(
            "JARVIS_SATELLITE_VAD_THRESHOLD",
            env.JARVIS_SATELLITE_VAD_THRESHOLD,
            0.01,
            0.0001,
        ),
        vadOnsetMs: envNumber(
            "JARVIS_SATELLITE_VAD_ONSET_MS",
            env.JARVIS_SATELLITE_VAD_ONSET_MS,
            150,
            20,
        ),
        vadSilenceMs: envNumber(
            "JARVIS_SATELLITE_VAD_SILENCE_MS",
            env.JARVIS_SATELLITE_VAD_SILENCE_MS,
            800,
            100,
        ),
        vadPreRollMs: envNumber(
            "JARVIS_SATELLITE_VAD_PREROLL_MS",
            env.JARVIS_SATELLITE_VAD_PREROLL_MS,
            1_000,
            0,
        ),
        vadMaxUtteranceMs: envNumber(
            "JARVIS_SATELLITE_VAD_MAX_UTTERANCE_MS",
            env.JARVIS_SATELLITE_VAD_MAX_UTTERANCE_MS,
            15_000,
            1_000,
        ),
        wakeFollowUpMs: envNumber(
            "JARVIS_SATELLITE_WAKE_FOLLOWUP_MS",
            env.JARVIS_SATELLITE_WAKE_FOLLOWUP_MS,
            5_000,
            0,
        ),
        conversationFollowUpMs: envNumber(
            "JARVIS_SATELLITE_CONVERSATION_FOLLOWUP_MS",
            env.JARVIS_SATELLITE_CONVERSATION_FOLLOWUP_MS,
            3_000,
            0,
        ),
        bargeInEnabled: envBool(env.JARVIS_SATELLITE_BARGE_IN, true),
        bargeInThreshold: envNumber(
            "JARVIS_SATELLITE_BARGE_IN_THRESHOLD",
            env.JARVIS_SATELLITE_BARGE_IN_THRESHOLD,
            0.035,
            0.0001,
        ),
        bargeInMs: envNumber(
            "JARVIS_SATELLITE_BARGE_IN_MS",
            env.JARVIS_SATELLITE_BARGE_IN_MS,
            300,
            50,
        ),
        bargeInPreRollMs: envNumber(
            "JARVIS_SATELLITE_BARGE_IN_PREROLL_MS",
            env.JARVIS_SATELLITE_BARGE_IN_PREROLL_MS,
            500,
            0,
        ),
        localTts: envBool(env.JARVIS_SATELLITE_LOCAL_TTS, false),
    };
}
