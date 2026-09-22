/** Default base URL of the local LM Studio OpenAI-compatible server. */
import { homedir } from "node:os";
import type { RateLimitConfig } from "./http/rateLimit";

export const DEFAULT_LLM_BASE_URL = "http://localhost:1234/v1";

/** Default HTTP port the server listens on. */
export const DEFAULT_PORT = 54321;

/** Default bind address. `0.0.0.0` keeps LAN reachability (the intended LAN posture). */
export const DEFAULT_HOST = "0.0.0.0";

/** Default model served by the local inference server. */
export const DEFAULT_LLM_MODEL = "qwen/qwen3-4b-2507";

/** Default sampling temperature. */
export const DEFAULT_LLM_TEMPERATURE = 0;

/** Default maximum model/tool turns per agent run before the graph aborts. */
export const DEFAULT_AGENT_MAX_TURNS = 10;

/**
 * Default location of the LangGraph checkpoint database.
 *
 * Each WebSocket session (identified by its `sessionId`) maps to one graph
 * thread, and every thread's message history is persisted here so
 * conversations survive server restarts.
 */
export function defaultCheckpointPath(): string {
    return `${homedir()}/.jarvis/checkpoints.sqlite`;
}

/**
 * Default location of the app database (users, devices, sessions, prefs).
 *
 * Separate from the LangGraph checkpoint store; holds the account and
 * session ledger in `~/.jarvis/jarvis.sqlite`.
 */
export function defaultAppDbPath(): string {
    return `${homedir()}/.jarvis/jarvis.sqlite`;
}

/** Default hard cap for one agent turn before it is aborted. */
export const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/** Default persona the assistant is primed with on every conversation thread. */
export const DEFAULT_SYSTEM_PROMPT =
    "You are J.A.R.V.I.S., a helpful, personal AI assistant. " +
    "Answer directly and concisely; avoid unnecessary verbosity, markup, " +
    "and preamble. Never use emojis to convey emotion (smiling, crying, " +
    "frowning, and similar); utilitarian symbols such as checkmarks, X's, " +
    "circles, and signs are fine in moderation.";

/**
 * Resolves LLM settings from the environment.
 *
 * Defaults match the local LM Studio OpenAI-compatible server, overridable
 * via the `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TEMPERATURE`, and
 * `LLM_SYSTEM_PROMPT` environment variables. `streamUsage` is fixed off
 * because local OpenAI-compatible endpoints typically do not emit streaming
 * token-usage metadata.
 */
export interface LlmConfig {
    baseUrl: string;
    model: string;
    temperature: number;
    streamUsage: boolean;
    systemPrompt: string;
    agentMaxTurns: number;
    checkpointPath: string;
}

/**
 * Resolves the HTTP port the server listens on.
 *
 * Reads the `PORT` environment variable, falling back to `DEFAULT_PORT`. The
 * default is referenced by the CLI's default server URL
 * (`packages/cli/src/config.ts`) — keep them in sync.
 */
export function getServerPort(): number {
    return Number(process.env.PORT ?? DEFAULT_PORT);
}

export function getLlmConfig(): LlmConfig {
    return {
        baseUrl: process.env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
        model: process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
        temperature: Number(
            process.env.LLM_TEMPERATURE ?? DEFAULT_LLM_TEMPERATURE,
        ),
        streamUsage: false,
        systemPrompt: process.env.LLM_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
        agentMaxTurns: Number(
            process.env.JARVIS_AGENT_MAX_TURNS ?? DEFAULT_AGENT_MAX_TURNS,
        ),
        checkpointPath:
            process.env.JARVIS_CHECKPOINT_PATH ?? defaultCheckpointPath(),
    };
}

/**
 * App-level settings (accounts, sessions, and resource control).
 *
 * These are operator/account concerns rather than LLM configuration, so they
 * are resolved separately from `getLlmConfig`. `bootstrapToken` is
 * deliberately `undefined` by default: first-owner setup stays disabled until
 * the operator sets the environment variable, so a fresh server never races an
 * anonymous admin. `host`, `tlsCertPath`, `tlsKeyPath`, and `loginRateLimit`
 * are optional so hand-built configs (tests) can omit them; `getAppConfig`
 * always fills them in, and consumers fall back to defaults when absent.
 */
export interface AppConfig {
    /** Path of the app database (`JARVIS_DB_PATH`). */
    appDbPath: string;
    /** Hard cap for one agent turn before the server aborts it. */
    turnTimeoutMs: number;
    /** One-time token permitting first-owner bootstrap; disabled when unset. */
    bootstrapToken: string | undefined;
    /** Bind address for the listener (`JARVIS_HOST`), default all interfaces. */
    host?: string;
    /** Path to a PEM certificate to serve HTTPS (`JARVIS_TLS_CERT`). */
    tlsCertPath?: string;
    /** Path to the matching PEM private key (`JARVIS_TLS_KEY`). */
    tlsKeyPath?: string;
    /** Login/bootstrap throttle settings (`JARVIS_RATE_*`), default LAN values. */
    loginRateLimit?: RateLimitConfig;
}

export function getAppConfig(): AppConfig {
    const numberOr = (raw: string | undefined, fallback: number): number => {
        const value = Number(raw);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return {
        appDbPath: process.env.JARVIS_DB_PATH ?? defaultAppDbPath(),
        turnTimeoutMs: Number(
            process.env.JARVIS_TURN_TIMEOUT_MS ?? DEFAULT_TURN_TIMEOUT_MS,
        ),
        bootstrapToken: process.env.JARVIS_BOOTSTRAP_TOKEN || undefined,
        host: process.env.JARVIS_HOST ?? DEFAULT_HOST,
        tlsCertPath: process.env.JARVIS_TLS_CERT || undefined,
        tlsKeyPath: process.env.JARVIS_TLS_KEY || undefined,
        loginRateLimit: {
            windowMs: numberOr(process.env.JARVIS_RATE_WINDOW_MS, 15 * 60_000),
            maxFailures: numberOr(process.env.JARVIS_RATE_MAX_FAILURES, 10),
            lockoutMs: numberOr(process.env.JARVIS_RATE_LOCKOUT_MS, 60_000),
            maxIpFailures: numberOr(
                process.env.JARVIS_RATE_MAX_IP_FAILURES,
                100,
            ),
        },
    };
}
