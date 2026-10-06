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
export const DEFAULT_LLM_TEMPERATURE = 0.15;

/** Default maximum model/tool turns per agent run before the graph aborts. */
export const DEFAULT_AGENT_MAX_TURNS = 10;

/**
 * Default vision-language model used by the `analyzeImage` tool.
 *
 * Distinct from {@link DEFAULT_LLM_MODEL} on purpose: the chat model is a
 * small text-only model, while image analysis needs a VL model. Must name a
 * model on the same OpenAI-compatible server (`LLM_BASE_URL`) that accepts
 * `image_url` content parts; the server warns at startup when the name is
 * absent from `/v1/models`.
 */
export const DEFAULT_LLM_VL_MODEL = "qwen3.6-35b-a3b-splash";

/** Default cap for one vision-language analysis call, in output tokens. */
export const DEFAULT_LLM_VL_MAX_TOKENS = 1024;

/** Default hard cap for one vision-language analysis call, in milliseconds. */
export const DEFAULT_LLM_VL_TIMEOUT_MS = 60_000;

/** Default TTL for uploaded attachments, in milliseconds (60 minutes). */
export const DEFAULT_ATTACHMENT_TTL_MS = 60 * 60_000;

/** Default per-attachment cap in decoded bytes (4 MiB). */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

/** Default per-user total across live attachments, in bytes (200 MiB). */
export const DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/** Default vision-language analysis calls allowed per user per minute. */
export const DEFAULT_ATTACHMENT_VL_CALLS_PER_MIN = 10;

/** Default concurrent uploads in flight (server-wide). */
export const DEFAULT_ATTACHMENT_MAX_INFLIGHT = 4;

/** Default wall-clock cap for one web-search API call, in milliseconds. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;

/** Default number of search results handed to the model. */
export const DEFAULT_SEARCH_MAX_RESULTS = 5;

/** Default web-search calls allowed per user per minute. */
export const DEFAULT_SEARCH_CALLS_PER_MIN = 20;

/** Default wall-clock cap for one weather API call, in milliseconds. */
export const DEFAULT_WEATHER_TIMEOUT_MS = 10_000;

/** Default weather calls allowed per user per minute. */
export const DEFAULT_WEATHER_CALLS_PER_MIN = 10;

/** Default unit system the weather tool reports. */
export const DEFAULT_WEATHER_UNITS: WeatherUnits = "imperial";

/** Default wall-clock cap for one Home Assistant call, in milliseconds. */
export const DEFAULT_HA_TIMEOUT_MS = 10_000;

/** Default Home Assistant calls allowed per user per minute. */
export const DEFAULT_HA_CALLS_PER_MIN = 10;

/** Default freshness of the cached Home Assistant state snapshot. */
export const DEFAULT_HA_CACHE_TTL_MS = 15_000;

/** Default ceiling on how many entities the tool lists at once. */
export const DEFAULT_HA_LIST_LIMIT = 40;

/**
 * Substrings that make a `light.*`/`switch.*` entity read as a light to the
 * tool's `lights` action (#15).
 *
 * A light is not a domain on every instance — many are modeled as switches —
 * and no field in the REST payload marks one, so discovery matches these
 * against the entity id and friendly name. `JARVIS_HA_LIGHT_TOKENS` overrides
 * the list for an instance whose devices name themselves differently.
 */
export const DEFAULT_HA_LIGHT_TOKENS: readonly string[] = [
    "light",
    "lamp",
    "bulb",
    "strip",
    "ceiling",
    "sconce",
    "luminaire",
    "fixture",
];

/**
 * Entity domains the tool may READ by default (#15).
 *
 * Deliberately broader than {@link DEFAULT_HA_CONTROL_DOMAINS}: reading a lock's
 * state or a door sensor's value is harmless and useful, while writing to one is
 * a different risk class. `button`, `scene`, and `script` are absent entirely.
 */
export const DEFAULT_HA_READ_DOMAINS: readonly string[] = [
    "light",
    "switch",
    "climate",
    "fan",
    "sensor",
    "binary_sensor",
    "cover",
    "media_player",
    "lock",
];

/**
 * Entity domains the tool may WRITE by default (#15) — the writable subset of
 * {@link DEFAULT_HA_READ_DOMAINS}.
 */
export const DEFAULT_HA_CONTROL_DOMAINS: readonly string[] = [
    "light",
    "switch",
    "climate",
    "fan",
];

/**
 * Web-search provider settings (#9).
 *
 * Two providers with different economics: Tavily (LLM-optimized, a free
 * monthly quota) serves the general/news/finance verticals; Serper
 * (pay-as-you-go Google SERP) serves the verticals Tavily does not have —
 * images, videos, places, reviews, patents, shopping, scholar.
 *
 * The API keys are secrets carried in the environment; they are never
 * logged and never returned to clients. When NEITHER key is configured the
 * `search` setting is left undefined and the `webSearch` tool is not
 * registered at all.
 */
export interface SearchConfig {
    /** Tavily API key (`TAVILY_API_KEY`); enables the Tavily-backed verticals. */
    readonly tavilyApiKey?: string;
    /** Serper API key (`SERPER_API_KEY`); enables the Serper-only verticals. */
    readonly serperApiKey?: string;
    /** Wall-clock cap for one provider call (`JARVIS_SEARCH_TIMEOUT_MS`). */
    readonly timeoutMs: number;
    /** Results handed to the model per call (`JARVIS_SEARCH_MAX_RESULTS`). */
    readonly maxResults: number;
    /** Per-user search calls per minute (`JARVIS_SEARCH_CALLS_PER_MIN`). */
    readonly callsPerMin: number;
}

/**
 * Unit systems the weather tool can report (#31).
 *
 * Deliberately narrower than OpenWeather's `standard|metric|imperial` set:
 * Kelvin ("standard") is useless in conversation, so the config rejects it
 * rather than letting a stray default put Kelvin in front of the model.
 */
export type WeatherUnits = "metric" | "imperial";

/**
 * Weather provider settings (#31).
 *
 * OpenWeather's free tier serves current conditions and the 5-day/3-hour
 * forecast at 60 calls/minute account-wide (1M/month) — no card required.
 * One provider, one key; no routing layer.
 *
 * The API key is a secret carried in the environment; it is never logged and
 * never returned to clients. When the key is not configured the `weather`
 * setting is left undefined and the `getWeather` tool is not registered at
 * all. Note that freshly created OpenWeather keys stay unactivated for
 * 10 minutes–2 hours (the provider answers 401 meanwhile) — that is provider
 * behavior, not a config problem.
 */
export interface WeatherConfig {
    /** OpenWeather API key (`OPENWEATHER_API_KEY`). */
    readonly apiKey: string;
    /** Unit system for temperatures and wind (`JARVIS_WEATHER_UNITS`). */
    readonly units: WeatherUnits;
    /** Wall-clock cap for one provider call (`JARVIS_WEATHER_TIMEOUT_MS`). */
    readonly timeoutMs: number;
    /** Per-user weather calls per minute (`JARVIS_WEATHER_CALLS_PER_MIN`). */
    readonly callsPerMin: number;
}

/**
 * Home Assistant connection settings (#15).
 *
 * Both the URL and the long-lived access token are required, and neither has a
 * default: the URL is a private LAN address that must never be baked into the
 * source, and a missing token must leave the tool unregistered rather than
 * failing at request time. When EITHER is missing the `homeAssistant` setting is
 * undefined and the tool does not exist for this deployment.
 *
 * The token is a secret carried in the environment. It is never logged, never
 * included in error text, and leaves the process only as a request header.
 */
export interface HomeAssistantConfig {
    /** Base URL of the instance, no trailing slash (`HOME_ASSISTANT_URL`). */
    readonly url: string;
    /** Long-lived access token (`HOME_ASSISTANT_ACCESS_TOKEN`); a secret. */
    readonly accessToken: string;
    /** Domains whose entities may be read (`JARVIS_HA_READ_DOMAINS`). */
    readonly readDomains: readonly string[];
    /** Domains whose entities may be written (`JARVIS_HA_CONTROL_DOMAINS`). */
    readonly controlDomains: readonly string[];
    /** Per-user calls per minute (`JARVIS_HA_CALLS_PER_MIN`). */
    readonly callsPerMin: number;
    /** Wall-clock cap for one call (`JARVIS_HA_TIMEOUT_MS`). */
    readonly timeoutMs: number;
    /** How long a fetched state snapshot is reused (`JARVIS_HA_CACHE_TTL_MS`). */
    readonly cacheTtlMs: number;
    /** Ceiling on entities listed per call (`JARVIS_HA_LIST_LIMIT`). */
    readonly listLimit: number;
    /**
     * Name fragments that make a light a light to `action: "lights"`
     * (`JARVIS_HA_LIGHT_TOKENS`).
     *
     * Lowercased and trimmed at parse time. An explicitly empty value yields an
     * empty list — no token matches, so `lights` finds nothing — the same
     * fail-closed posture as an empty `JARVIS_HA_READ_DOMAINS`.
     */
    readonly lightTokens: readonly string[];
}

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
    /** Vision-language model the `analyzeImage` tool calls (`LLM_VL_MODEL`). */
    vlModel: string;
    /** Output-token cap for one VL analysis call (`LLM_VL_MAX_TOKENS`). */
    vlMaxTokens: number;
    /** Wall-clock cap for one VL analysis call (`LLM_VL_TIMEOUT_MS`). */
    vlTimeoutMs: number;
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
        vlModel: process.env.LLM_VL_MODEL ?? DEFAULT_LLM_VL_MODEL,
        vlMaxTokens: Number(
            process.env.LLM_VL_MAX_TOKENS ?? DEFAULT_LLM_VL_MAX_TOKENS,
        ),
        vlTimeoutMs: Number(
            process.env.LLM_VL_TIMEOUT_MS ?? DEFAULT_LLM_VL_TIMEOUT_MS,
        ),
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
     * Resource controls for transient image attachments (`JARVIS_ATTACHMENT_*`).
     *
     * Optional so hand-built configs (tests) can omit it;
     * {@link DEFAULT_ATTACHMENT_CONFIG} fills the gaps. These are quotas, not
     * rate limiting — see the rate-limiting section of the package README for
     * why the two are separate mechanisms.
     */
    readonly attachments?: AttachmentConfig;
    /**
     * Web-search provider settings (#9), present only when at least one
     * provider API key is configured — no keys, no `webSearch` tool.
     * Optional so hand-built configs (tests) can omit it.
     */
    readonly search?: SearchConfig;
    /**
     * Weather provider settings (#31), present only when the OpenWeather API
     * key is configured — no key, no `getWeather` tool. Optional so hand-built
     * configs (tests) can omit it.
     */
    readonly weather?: WeatherConfig;
    /**
     * Home Assistant connection settings (#15), present only when BOTH the URL
     * and the access token are configured — no credentials, no `homeAssistant`
     * tool. Optional so hand-built configs (tests) can omit it.
     */
    readonly homeAssistant?: HomeAssistantConfig;
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
 * Resource controls for transient image attachments (#10).
 *
 * These bound per-user temp-disk and vision-model compute; they are quotas,
 * deliberately separate from `RateLimitConfig` (whose success-clears-key
 * semantics are wrong for "N held" or "N per minute" budgets).
 */
export interface AttachmentConfig {
    /** How long an uploaded attachment stays readable (`JARVIS_ATTACHMENT_TTL_MINUTES`). */
    readonly ttlMs: number;
    /** Decoded-byte cap for one attachment (`JARVIS_ATTACHMENT_MAX_BYTES`). */
    readonly maxBytes: number;
    /** Per-user total across live attachments (`JARVIS_ATTACHMENT_MAX_TOTAL_BYTES`). */
    readonly maxTotalBytes: number;
    /** Vision-model analysis calls per user per minute (`JARVIS_ATTACHMENT_VL_CALLS_PER_MIN`). */
    readonly vlCallsPerMin: number;
    /** Concurrent uploads in flight, server-wide (`JARVIS_ATTACHMENT_MAX_INFLIGHT`). */
    readonly maxInflight: number;
    /**
     * Root directory holding attachment files; created on demand and
     * mode-verified at use (`JARVIS_ATTACHMENT_DIR`). Defaults under
     * `os.tmpdir()`.
     */
    readonly dir?: string;
}

/** LAN-reasonable attachment defaults (see the individual constants). */
export const DEFAULT_ATTACHMENT_CONFIG: AttachmentConfig = {
    ttlMs: DEFAULT_ATTACHMENT_TTL_MS,
    maxBytes: DEFAULT_ATTACHMENT_MAX_BYTES,
    maxTotalBytes: DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES,
    vlCallsPerMin: DEFAULT_ATTACHMENT_VL_CALLS_PER_MIN,
    maxInflight: DEFAULT_ATTACHMENT_MAX_INFLIGHT,
};

/**
 * Parses a minutes-valued env var into milliseconds.
 *
 * Returns `undefined` for absent input so `numberOr` can apply its fallback;
 * a non-numeric or non-positive value also yields `undefined` (the fallback),
 * matching `numberOr`'s own recovery behavior.
 */
function minutesToMs(raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const minutes = Number(raw);
    return Number.isFinite(minutes) && minutes > 0
        ? minutes * 60_000
        : undefined;
}

/**
 * Splits a comma-separated env var into trimmed, non-empty entries.
 *
 * Returns `undefined` for absent/blank input so callers can distinguish
 * "unset" from "set but empty" without a second parse.
 */ function csv(raw: string | undefined): string[] | undefined {
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
    /**
     * Like `numberOr` but accepts 0, for knobs where zero is a real setting
     * rather than a missing one (the Home Assistant cache TTL: 0 disables
     * caching, which is how you debug against a live instance without stale
     * reads).
     */
    const zeroOkOr = (raw: string | undefined, fallback: number): number => {
        const value = Number(raw);
        return Number.isFinite(value) && value >= 0 ? value : fallback;
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
        attachments:
            process.env.JARVIS_ATTACHMENT_TTL_MINUTES === undefined &&
            process.env.JARVIS_ATTACHMENT_MAX_BYTES === undefined &&
            process.env.JARVIS_ATTACHMENT_MAX_TOTAL_BYTES === undefined &&
            process.env.JARVIS_ATTACHMENT_VL_CALLS_PER_MIN === undefined &&
            process.env.JARVIS_ATTACHMENT_MAX_INFLIGHT === undefined &&
            process.env.JARVIS_ATTACHMENT_DIR === undefined
                ? undefined
                : {
                      ttlMs:
                          minutesToMs(
                              process.env.JARVIS_ATTACHMENT_TTL_MINUTES,
                          ) ?? DEFAULT_ATTACHMENT_TTL_MS,
                      maxBytes: numberOr(
                          process.env.JARVIS_ATTACHMENT_MAX_BYTES,
                          DEFAULT_ATTACHMENT_MAX_BYTES,
                      ),
                      maxTotalBytes: numberOr(
                          process.env.JARVIS_ATTACHMENT_MAX_TOTAL_BYTES,
                          DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES,
                      ),
                      vlCallsPerMin: numberOr(
                          process.env.JARVIS_ATTACHMENT_VL_CALLS_PER_MIN,
                          DEFAULT_ATTACHMENT_VL_CALLS_PER_MIN,
                      ),
                      maxInflight: numberOr(
                          process.env.JARVIS_ATTACHMENT_MAX_INFLIGHT,
                          DEFAULT_ATTACHMENT_MAX_INFLIGHT,
                      ),
                      dir: process.env.JARVIS_ATTACHMENT_DIR || undefined,
                  },
        search:
            !process.env.TAVILY_API_KEY && !process.env.SERPER_API_KEY
                ? undefined
                : {
                      tavilyApiKey: process.env.TAVILY_API_KEY || undefined,
                      serperApiKey: process.env.SERPER_API_KEY || undefined,
                      timeoutMs: numberOr(
                          process.env.JARVIS_SEARCH_TIMEOUT_MS,
                          DEFAULT_SEARCH_TIMEOUT_MS,
                      ),
                      maxResults: numberOr(
                          process.env.JARVIS_SEARCH_MAX_RESULTS,
                          DEFAULT_SEARCH_MAX_RESULTS,
                      ),
                      callsPerMin: numberOr(
                          process.env.JARVIS_SEARCH_CALLS_PER_MIN,
                          DEFAULT_SEARCH_CALLS_PER_MIN,
                      ),
                  },
        weather: !process.env.OPENWEATHER_API_KEY
            ? undefined
            : {
                  apiKey: process.env.OPENWEATHER_API_KEY,
                  // Unknown values fall back to the default unit rather
                  // than erroring — same silent-recovery posture as
                  // numberOr, so a typo can never break the server start.
                  units:
                      process.env.JARVIS_WEATHER_UNITS === "metric"
                          ? "metric"
                          : DEFAULT_WEATHER_UNITS,
                  timeoutMs: numberOr(
                      process.env.JARVIS_WEATHER_TIMEOUT_MS,
                      DEFAULT_WEATHER_TIMEOUT_MS,
                  ),
                  callsPerMin: numberOr(
                      process.env.JARVIS_WEATHER_CALLS_PER_MIN,
                      DEFAULT_WEATHER_CALLS_PER_MIN,
                  ),
              },
        homeAssistant:
            !process.env.HOME_ASSISTANT_URL ||
            !process.env.HOME_ASSISTANT_ACCESS_TOKEN
                ? undefined
                : {
                      // An operator's trailing slash would otherwise produce
                      // `//api/states`, which Home Assistant 404s.
                      url: process.env.HOME_ASSISTANT_URL.replace(/\/+$/, ""),
                      accessToken: process.env.HOME_ASSISTANT_ACCESS_TOKEN,
                      // Domain lists fall back to the documented defaults on a
                      // typo, so a bad value narrows or widens rather than
                      // emptying the tool.
                      readDomains:
                          csv(process.env.JARVIS_HA_READ_DOMAINS)?.map(
                              (domain) => domain.toLowerCase(),
                          ) ?? DEFAULT_HA_READ_DOMAINS,
                      controlDomains:
                          csv(process.env.JARVIS_HA_CONTROL_DOMAINS)?.map(
                              (domain) => domain.toLowerCase(),
                          ) ?? DEFAULT_HA_CONTROL_DOMAINS,
                      callsPerMin: numberOr(
                          process.env.JARVIS_HA_CALLS_PER_MIN,
                          DEFAULT_HA_CALLS_PER_MIN,
                      ),
                      timeoutMs: numberOr(
                          process.env.JARVIS_HA_TIMEOUT_MS,
                          DEFAULT_HA_TIMEOUT_MS,
                      ),
                      // 0 is allowed: it turns the snapshot cache off.
                      cacheTtlMs: zeroOkOr(
                          process.env.JARVIS_HA_CACHE_TTL_MS,
                          DEFAULT_HA_CACHE_TTL_MS,
                      ),
                      listLimit: numberOr(
                          process.env.JARVIS_HA_LIST_LIMIT,
                          DEFAULT_HA_LIST_LIMIT,
                      ),
                      // Lowercased so the matcher never compares case.
                      lightTokens:
                          csv(process.env.JARVIS_HA_LIGHT_TOKENS)?.map(
                              (token) => token.toLowerCase(),
                          ) ?? DEFAULT_HA_LIGHT_TOKENS,
                  },
        corsOrigins: csv(process.env.JARVIS_CORS_ORIGINS)?.map(normalizeOrigin),
        trustProxyCidrs: csv(process.env.JARVIS_TRUST_PROXY_CIDRS)?.map(
            (cidr) => cidr.toLowerCase(),
        ),
    };
}
