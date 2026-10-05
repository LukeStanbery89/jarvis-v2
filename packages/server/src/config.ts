/** Default base URL of the local LM Studio OpenAI-compatible server. */
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_SESSION_TTL_MS } from "@lukestanbery/jarvis-auth";

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

/**
 * Default location of the built web portal when none is configured.
 *
 * The portal package (`packages/portal`) compiles to `packages/portal/dist`;
 * from the server's `src/` (tsx dev) *and* `dist/` (compiled) both resolve to
 * `packages/portal/dist` via `../..`. `createApp` mounts the folder only when
 * its `index.html` actually exists, so a server running without a portal build
 * falls back to the plain "Hello World" root.
 */
export function defaultPortalDir(): string {
    return path.resolve(__dirname, "../../portal/dist");
}

/**
 * Default location of the built web chat client when none is configured.
 *
 * The web package (`packages/web`) compiles to `packages/web/dist`; from the
 * server's `src/` (tsx dev) *and* `dist/` (compiled) both resolve to
 * `packages/web/dist` via `../..`. `createApp` mounts the folder at `/web`
 * only when its `index.html` actually exists, so a server running without a
 * web build simply has no chat client mounted.
 */
export function defaultWebDir(): string {
    return path.resolve(__dirname, "../../web/dist");
}

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
 * Throttle settings for the credential endpoints.
 *
 * Lives here (not in `http/`) so the config module never depends on the HTTP
 * layer — `src/http/rateLimit.ts` imports it from config, keeping the
 * dependency direction pointing downward.
 */
export interface RateLimitConfig {
    /** Fixed window during which attempts accumulate. */
    readonly windowMs: number;
    /** Attempts allowed per key before a lockout begins. */
    readonly maxFailures: number;
    /** Base lockout duration; doubles (×2, ×4, …) per repeat until capped. */
    readonly lockoutMs: number;
    /** Aggregate attempt cap per IP, regardless of which username is hit. */
    readonly maxIpFailures: number;
}

/** LAN-reasonable defaults: 10 attempts/user/15 min, 100 attempts/IP/15 min. */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
    windowMs: 15 * 60_000,
    maxFailures: 10,
    lockoutMs: 60_000,
    maxIpFailures: 100,
};

/**
 * App-level settings (accounts, sessions, and resource control).
 *
 * These are operator/account concerns rather than LLM configuration, so they
 * are resolved separately from `getLlmConfig`. `bootstrapToken` is
 * deliberately `undefined` by default: first-owner setup stays disabled until
 * the operator sets the environment variable, so a fresh server never races an
 * anonymous admin. `host`, `tlsCertPath`, `tlsKeyPath`, `httpRedirectPort`,
 * `loginRateLimit`, `corsOrigins`, and `trustProxyCidrs` are optional so
 * hand-built configs (tests) can omit them; `getAppConfig` always fills them in,
 * and consumers fall back to defaults when absent.
 */
export interface AppConfig {
    /** Path of the app database (`JARVIS_DB_PATH`). */
    readonly appDbPath: string;
    /** Hard cap for one agent turn before the server aborts it. */
    readonly turnTimeoutMs: number;
    /** One-time token permitting first-owner bootstrap; disabled when unset. */
    readonly bootstrapToken: string | undefined;
    /**
     * Browser cookie-session lifetime (`JARVIS_SESSION_TTL_MS`), defaulting to
     * the auth package's 30-day absolute expiry. Optional so hand-built configs
     * (tests) can omit it; `getAppConfig` always fills it in.
     */
    readonly sessionTtlMs?: number;
    /** Bind address for the listener (`JARVIS_HOST`), default all interfaces. */
    readonly host?: string;
    /** Path to a PEM certificate to serve HTTPS (`JARVIS_TLS_CERT`). */
    readonly tlsCertPath?: string;
    /** Path to the matching PEM private key (`JARVIS_TLS_KEY`). */
    readonly tlsKeyPath?: string;
    /**
     * Cleartext upgrade port used when TLS is enabled
     * (`JARVIS_HTTP_REDIRECT_PORT`); defaults to `port + 1` when unset.
     */
    readonly httpRedirectPort?: number;
    /**
     * Directory of the built web portal to serve at `/` (`JARVIS_PORTAL_DIR`).
     * When unset, `getAppConfig` resolves the workspace's `packages/portal/dist`
     * and `createApp` mounts it only if `index.html` exists. Set to an explicit
     * path to override, or to the empty string to disable portal serving.
     */
    readonly portalDir?: string;
    /**
     * Directory of the built web chat client to serve at `/web`
     * (`JARVIS_WEB_DIR`). When unset, `getAppConfig` resolves the workspace's
     * `packages/web/dist` and `createApp` mounts it only if `index.html`
     * exists. Set to an explicit path to override, or to the empty string to
     * disable web-chat serving (leaving a bare `/web` to 404).
     */
    readonly webDir?: string;
    /** Login/bootstrap throttle settings (`JARVIS_RATE_*`), default LAN values. */
    readonly loginRateLimit?: RateLimitConfig;
    /**
     * Whether the server also verifies REST response bodies against the
     * OpenAPI contract (`JARVIS_API_CONTRACT=verify`). Request shapes are
     * always validated when the spec is available; response checking is
     * opt-in so production latency and noise stay unchanged — local dev
     * (`npm run dev`) and the contract tests turn it on.
     */
    readonly apiContractVerify?: boolean;
    /**
     * Exact browser origins permitted to call the REST API cross-origin
     * (`JARVIS_CORS_ORIGINS`), comma-separated. Unset or empty **denies all
     * cross-origin browser requests** — the server emits no
     * `Access-Control-Allow-Origin`, so the browser blocks them and
     * same-origin clients (including the SPAs this server hosts) are
     * unaffected. Entries are normalized (see {@link normalizeOrigin}); a
     * literal `*` is not supported, because the API is credentialed and
     * browsers reject `*` alongside credentials anyway.
     */
    readonly corsOrigins?: readonly string[];
    /**
     * IPs and subnets whose `X-Forwarded-For` header is believed when
     * deriving `req.ip` (`JARVIS_TRUST_PROXY_CIDRS`), comma-separated.
     *
     * Unset or empty trusts nothing, which is the safe default: `req.ip` is
     * then the socket address, so per-IP rate limiting is correct but every
     * client behind a reverse proxy shares one bucket. Populating this makes
     * those buckets per-client again. Entries that fail to parse never match,
     * so a typo fails closed rather than open. See `src/http/cors.ts` and
     * {@link AppConfig.corsOrigins} for the cross-origin story.
     */
    readonly trustProxyCidrs?: readonly string[];
}

/**
 * Splits a comma-separated env var into trimmed, non-empty entries.
 *
 * Returns `undefined` for absent/blank input so callers can distinguish
 * "unset" from "set but empty" without a second parse.
 */
function csv(raw: string | undefined): string[] | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const parts = raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    return parts.length > 0 ? parts : [];
}

/**
 * Normalizes a configured CORS origin to the exact form a browser sends in
 * `Origin`, so an operator's trailing slash does not silently fail to match.
 *
 * The scheme and host are case-insensitive and an origin carries no path, so
 * lowercasing and dropping a single trailing `/` is safe and lossless.
 * Anything else is passed through untouched (including a malformed entry,
 * which simply never matches).
 */
export function normalizeOrigin(origin: string): string {
    const trimmed = origin.trim();
    if (trimmed.endsWith("/")) {
        return trimmed.replace(/\/+$/, "").toLowerCase();
    }
    return trimmed.toLowerCase();
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
        sessionTtlMs: numberOr(
            process.env.JARVIS_SESSION_TTL_MS,
            DEFAULT_SESSION_TTL_MS,
        ),
        host: process.env.JARVIS_HOST ?? DEFAULT_HOST,
        tlsCertPath: process.env.JARVIS_TLS_CERT || undefined,
        tlsKeyPath: process.env.JARVIS_TLS_KEY || undefined,
        httpRedirectPort: process.env.JARVIS_HTTP_REDIRECT_PORT
            ? numberOr(process.env.JARVIS_HTTP_REDIRECT_PORT, 0) || undefined
            : undefined,
        portalDir:
            process.env.JARVIS_PORTAL_DIR === ""
                ? undefined
                : process.env.JARVIS_PORTAL_DIR || defaultPortalDir(),
        webDir:
            process.env.JARVIS_WEB_DIR === ""
                ? undefined
                : process.env.JARVIS_WEB_DIR || defaultWebDir(),
        loginRateLimit: {
            windowMs: numberOr(process.env.JARVIS_RATE_WINDOW_MS, 15 * 60_000),
            maxFailures: numberOr(process.env.JARVIS_RATE_MAX_FAILURES, 10),
            lockoutMs: numberOr(process.env.JARVIS_RATE_LOCKOUT_MS, 60_000),
            maxIpFailures: numberOr(
                process.env.JARVIS_RATE_MAX_IP_FAILURES,
                100,
            ),
        },
        apiContractVerify: process.env.JARVIS_API_CONTRACT === "verify",
        corsOrigins: csv(process.env.JARVIS_CORS_ORIGINS)?.map(normalizeOrigin),
        trustProxyCidrs: csv(process.env.JARVIS_TRUST_PROXY_CIDRS)?.map(
            (cidr) => cidr.toLowerCase(),
        ),
    };
}
