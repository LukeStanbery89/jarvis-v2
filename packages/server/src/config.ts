import { readFileSync } from "node:fs";
/** Default base URL of the local LM Studio OpenAI-compatible server. */
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_SESSION_TTL_MS } from "@lukestanbery/jarvis-auth";
import { DEFAULT_KOKORO_VOICE } from "./tts/kokoro";
import { logger } from "./logger";

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

/** Default wiki language subdomain for the `wikipedia` tool (#8). */
export const DEFAULT_WIKIPEDIA_LANG = "en";

/** Default wall-clock cap for one Wikipedia API call, in milliseconds. */
export const DEFAULT_WIKIPEDIA_TIMEOUT_MS = 10_000;

/** Default leading sentences requested for a summary extract. */
export const DEFAULT_WIKIPEDIA_MAX_SENTENCES = 5;

/** Default character budget for a `detail: "full"` extract. */
export const DEFAULT_WIKIPEDIA_MAX_FULL_CHARS = 6_000;

/** Default candidate titles returned for an ambiguous query. */
export const DEFAULT_WIKIPEDIA_MAX_CANDIDATES = 5;

/** Default Wikipedia calls allowed per signed-in user per minute. */
export const DEFAULT_WIKIPEDIA_CALLS_PER_MIN = 20;

/** Default Wikipedia calls allowed per guest session per minute (strict). */
export const DEFAULT_WIKIPEDIA_GUEST_SESSION_PER_MIN = 3;

/** Default Wikipedia calls allowed per guest client address per minute. */
export const DEFAULT_WIKIPEDIA_GUEST_IP_PER_MIN = 10;

/**
 * Default `User-Agent` sent to the Wikimedia API.
 *
 * Wikimedia's policy requires a descriptive agent that identifies the client
 * and offers a contact point; a generic one may be blocked, and an empty one
 * is answered 403. Operators running a fork should override
 * `JARVIS_WIKIPEDIA_USER_AGENT` with their own project URL.
 */
export const DEFAULT_WIKIPEDIA_USER_AGENT =
    "jarvis-v2/0.1 (+https://github.com/LukeStanbery89/jarvis-v2)";

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
 * Wikipedia lookup settings (#8).
 *
 * Unlike every other optional tool, this one has **no credential** — no API
 * key, no token, no LAN URL — so there is nothing to gate registration on.
 * It is therefore enabled by default and switched off explicitly with
 * `JARVIS_WIKIPEDIA=off`, which is the deliberate divergence from the
 * key-gated tools: those are absent because they *cannot* work without
 * secrets, not because the tool surface should be opt-in.
 *
 * Nothing here is a secret. The `User-Agent` is required by Wikimedia's
 * policy rather than optional, and the budgets are the tool's own — a
 * signed-in allowance, plus two strictly smaller guest allowances applied
 * together (per session and per client address).
 */
export interface WikipediaConfig {
    /** Wiki language subdomain (`JARVIS_WIKIPEDIA_LANG`), e.g. `en`. */
    readonly lang: string;
    /** Wall-clock cap for one API call (`JARVIS_WIKIPEDIA_TIMEOUT_MS`). */
    readonly timeoutMs: number;
    /**
     * Leading sentences a summary extract asks for
     * (`JARVIS_WIKIPEDIA_MAX_SENTENCES`); the API caps this at 10.
     */
    readonly maxSentences: number;
    /**
     * Character budget for a `detail: "full"` extract
     * (`JARVIS_WIKIPEDIA_MAX_FULL_CHARS`) — the article is cut here and the
     * result states how much was omitted.
     */
    readonly maxFullChars: number;
    /** Candidate titles for an ambiguous query (`JARVIS_WIKIPEDIA_MAX_CANDIDATES`). */
    readonly maxCandidates: number;
    /** Per-user calls per minute (`JARVIS_WIKIPEDIA_CALLS_PER_MIN`). */
    readonly callsPerMin: number;
    /**
     * Per-session guest calls per minute
     * (`JARVIS_WIKIPEDIA_GUEST_SESSION_PER_MIN`) — deliberately much
     * stricter than the per-user budget.
     */
    readonly guestSessionPerMin: number;
    /**
     * Aggregate per-client-address guest calls per minute
     * (`JARVIS_WIKIPEDIA_GUEST_IP_PER_MIN`) — the bucket that survives a
     * guest opening a fresh socket for a fresh session.
     */
    readonly guestIpPerMin: number;
    /** Descriptive `User-Agent` (`JARVIS_WIKIPEDIA_USER_AGENT`). */
    readonly userAgent: string;
}

/**
 * Notification settings (#139).
 *
 * Three knobs, none of them a secret, so notifications need no credential to
 * gate on — like `wikipedia`, the surface is on by default and switched off
 * with `JARVIS_NOTIFY=off`, which removes the REST routes and the delivery
 * wiring entirely rather than leaving an endpoint that does nothing.
 *
 * The two budgets are the notification service's own (see the rate-limiting
 * section of the package README): `deliveriesPerMin` bounds *interruptions*
 * per user per minute — a producer that goes haywire cannot turn a chat client
 * into a firehose — and `maxPerUser` bounds how much history the store keeps,
 * trimming only settled rows.
 */
export interface NotifyConfig {
    /**
     * Pushes allowed per user per minute
     * (`JARVIS_NOTIFY_DELIVERIES_PER_MIN`), default 20.
     */
    readonly deliveriesPerMin: number;
    /**
     * Settled notifications kept per user (`JARVIS_NOTIFY_MAX_PER_USER`),
     * default 200. Undelivered ones are never evicted.
     */
    readonly maxPerUser: number;
}

/** LAN-reasonable notification defaults: 20 pushes/min, 200 kept per user. */
export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
    deliveriesPerMin: 20,
    maxPerUser: 200,
};

/**
 * Scheduler settings (#90).
 *
 * The loop is on by default and switched off with `JARVIS_SCHEDULER=off` (the
 * `JARVIS_NOTIFY=off` posture: no loop, no tool, no routes, rather than a
 * surface that does nothing). It needs the notification service to announce
 * what a run did, so a deployment with notifications off has no scheduler
 * either.
 *
 * `tickMs` is deliberately coarse: the queue is a table, so a scan finds
 * whatever is due *now*, and a restart has nothing to rebuild. The cost of
 * coarseness is that a job can run up to one tick late, which is irrelevant
 * next to the seconds a turn itself takes.
 *
 * `maxPerTick` bounds how much work one tick takes on, not how fast the
 * backlog drains — with the default of one, a hundred due jobs drain over a
 * hundred ticks rather than pinning the process. Raising it above 1 really does
 * run turns concurrently, against one model: a home server has one.
 *
 * `maxLatenessMs` is the honesty knob: a job whose moment passed while the
 * server was down runs late if it is within this window, and is recorded as
 * `missed` (with a notification saying so) if it is not. A reminder that fires
 * six hours after the fact is not a reminder.
 *
 * `modelRunsPerDay` is what recurrence made necessary (#90 phase 8c): a
 * repeating `prompt` job is a standing order to call the model, and 200 a day is
 * generous for a home assistant while still bounding a mistake. It is a
 * *budget* — counted per local day, persisted, and spent only by runs that
 * actually reach the model — not a rate: see the rate-limiting section of the
 * package README for why neither `RateLimiter` nor `FixedWindowQuota` is the
 * right shape.
 */
export interface SchedulerConfig {
    /** Interval between scans (`JARVIS_JOB_TICK_MS`), default 5000. */
    readonly tickMs: number;
    /** Jobs kept per user (`JARVIS_JOB_MAX_PER_USER`), default 50. */
    readonly maxPerUser: number;
    /** Latest a job may run and still be worth running, default 1h. */
    readonly maxLatenessMs: number;
    /** Jobs one tick takes on (`JARVIS_JOB_MAX_PER_TICK`), default 1. */
    readonly maxPerTick: number;
    /**
     * How far ahead a job may be set (`JARVIS_JOB_MAX_HORIZON_DAYS`), default
     * 366: a scheduling tool refuses a moment beyond it rather than storing a
     * row that can only be a mistake (a wrong year, a stray digit).
     */
    readonly maxHorizonDays: number;
    /**
     * Model-calling runs one account's schedule may spend per local day
     * (`JARVIS_JOB_MODEL_RUNS_PER_DAY`), default 200 (#90 phase 8c).
     */
    readonly modelRunsPerDay: number;
}

/** LAN-reasonable scheduler defaults: a 5s scan, 50 jobs, an hour of lateness. */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
    tickMs: 5000,
    maxPerUser: 50,
    maxLatenessMs: 60 * 60 * 1000,
    maxPerTick: 1,
    maxHorizonDays: 366,
    modelRunsPerDay: 200,
};

/**
 * Coding-sandbox settings (#141).
 *
 * Present only when `JARVIS_SANDBOX=docker`: a deployment with no container
 * runtime configured should not advertise a job surface it cannot honour, the
 * same posture `JARVIS_SCHEDULER=off` takes for the queue. Every field is a
 * resource or a policy the operator can tune, and the defaults are deliberately
 * modest — a coding job on a laptop must not be able to take the machine down.
 */
export interface SandboxConfig {
    /** The job image, built by this repository (`JARVIS_SANDBOX_IMAGE`). */
    readonly image: string;
    /** The daemon socket (`JARVIS_SANDBOX_DOCKER_SOCKET`). */
    readonly socketPath: string;
    /**
     * Where workspaces live **as the server sees them**
     * (`JARVIS_SANDBOX_WORKSPACE_ROOT`).
     */
    readonly workspaceRoot: string;
    /**
     * The same tree **as the Docker daemon sees it**
     * (`JARVIS_SANDBOX_WORKSPACE_HOST_ROOT`).
     *
     * They differ exactly when the server itself runs in a container: the
     * daemon resolves a bind source on the host, so passing the server's view
     * would silently mount an empty directory. Equal by default (dev runs the
     * server on the host); compose sets the host path.
     */
    readonly workspaceHostRoot: string;
    /** Jobs allowed to run at once (`JARVIS_SANDBOX_MAX_JOBS`), default 1. */
    readonly maxJobs: number;
    /** CPU cores per job (`JARVIS_SANDBOX_CPUS`), default 2. */
    readonly cpus: number;
    /** Memory ceiling per job in MiB (`JARVIS_SANDBOX_MEMORY_MB`), default 4096. */
    readonly memoryMb: number;
    /** Process ceiling per job (`JARVIS_SANDBOX_PIDS`), default 512. */
    readonly pids: number;
    /**
     * Wall-clock ceiling per job (`JARVIS_SANDBOX_WALL_CLOCK_MINUTES`),
     * default 45 minutes. The supervisor stops the container when it expires.
     */
    readonly wallClockMs: number;
    /**
     * `owner/name` repositories a job may clone (`JARVIS_SANDBOX_REPOS`).
     * Empty means none: the allowlist is a whitelist, not a default.
     */
    readonly repos: readonly string[];
    /**
     * The model id the agent asks for at {@link llmBaseUrl}
     * (`JARVIS_SANDBOX_MODEL`). Defaults to `big-pickle`, the free stealth
     * model on OpenCode's Console endpoint; a Go-plan or local endpoint
     * overrides this and {@link llmBaseUrl} together. Empty refuses to start a
     * job — a sandbox with no model would spend a clone to discover it has
     * nothing to think with.
     */
    readonly model: string;
    /**
     * The OpenAI-compatible endpoint a job's agent talks to
     * (`JARVIS_SANDBOX_LLM_BASE_URL`).
     *
     * Distinct from `LLM_BASE_URL` on purpose: the server may reach its model
     * at `localhost`, which inside a job container means the container. The
     * default is OpenCode's Console endpoint (not Go, because the free model
     * lives there); a deployment running a local model points this at the host
     * and leaves {@link apiKey} empty.
     */
    readonly llmBaseUrl: string;
    /**
     * The provider key a job's agent authenticates with
     * (`JARVIS_SANDBOX_API_KEY`).
     *
     * Empty means "no key", which is right for a local endpoint and refused for
     * a remote one. **Never logged**: the boot line says `apiKey=set|unset`, and
     * the key travels only in the job's environment. It is visible to the agent
     * inside the container — a deliberate v1 trade-off recorded on #141 (use an
     * OpenCode workspace key, never a personal provider key; the server-side
     * proxy is the target design).
     */
    readonly apiKey: string;
    /**
     * Extra `/etc/hosts` entries for job containers
     * (`JARVIS_SANDBOX_EXTRA_HOSTS`; `none` disables). Defaults to the
     * host-gateway alias the model is reached through.
     */
    readonly extraHosts: readonly string[];
    /**
     * Where the broker listens (`JARVIS_SANDBOX_PROXY_BIND`), default
     * `127.0.0.1`.
     *
     * Loopback is the safe default because OrbStack and Docker Desktop deliver
     * a container's request to the host's loopback: jobs reach the broker
     * through `host.docker.internal` while the LAN cannot. A compose deployment
     * binds `0.0.0.0` on an unpublished port instead, inside the private
     * network the job containers join.
     */
    readonly proxyBind: string;
    /** The broker's port (`JARVIS_SANDBOX_PROXY_PORT`), default 54322. */
    readonly proxyPort: number;
    /**
     * The URL a job's agent uses (`JARVIS_SANDBOX_PROXY_URL`), default
     * `http://host.docker.internal:<port>/v1`.
     *
     * Dev reaches the broker through the host-gateway name; compose points this
     * at the server service on the private sandbox network, where the broker's
     * port is not published at all.
     */
    readonly proxyUrl: string;
    /**
     * The broker's HMAC secret (`JARVIS_SANDBOX_PROXY_SECRET`).
     *
     * Empty means "load the private file beside the database, creating it on
     * first boot". It must stay stable across restarts: a resumed job's
     * container carries a token signed with the previous process's secret.
     */
    readonly proxySecret: string;
    /**
     * Requests one job may make through the broker
     * (`JARVIS_SANDBOX_PROXY_MAX_REQUESTS`), default 500.
     */
    readonly proxyMaxRequestsPerJob: number;
    /**
     * The Docker network job containers join (`JARVIS_SANDBOX_NETWORK`).
     *
     * Empty uses the engine's default bridge. Compose sets the private network
     * that also carries the broker, which is what keeps the broker unreachable
     * from the LAN without publishing its port.
     */
    readonly network: string;
    /**
     * Where a job's full output is written (`JARVIS_SANDBOX_LOG_ROOT`).
     *
     * Beside the workspaces by default (`~/.jarvis/logs/coding`). The file is
     * written live — a crash still leaves what the container said — while the
     * row keeps only a bounded tail.
     */
    readonly logRoot: string;
    /** Per-job log cap in MiB (`JARVIS_SANDBOX_LOG_MAX_MB`), default 10. */
    readonly logMaxMb: number;
    /**
     * How long a settled workspace is kept (`JARVIS_SANDBOX_WORKSPACE_RETENTION_DAYS`,
     * default 14) before the boot sweep removes it.
     *
     * A successful workspace is the only copy of its branch until #140 pushes
     * it; the window is the bridge until then, and can shrink to "until the
     * push" once it is.
     */
    readonly workspaceRetentionDays: number;
    /** How long a job's log file is kept (`JARVIS_SANDBOX_LOG_RETENTION_DAYS`), default 30. */
    readonly logRetentionDays: number;
    /**
     * Settled coding-job rows kept per user (`JARVIS_SANDBOX_KEEP_JOB_ROWS`),
     * default 100. Older rows are pruned at every settle.
     */
    readonly keepJobRows: number;
}

/** Laptop-safe sandbox defaults: one job, two cores, 4 GiB, 45 minutes. */
export const DEFAULT_SANDBOX_CONFIG = {
    image: "jarvis-job:latest",
    socketPath: "/var/run/docker.sock",
    maxJobs: 1,
    cpus: 2,
    memoryMb: 4096,
    pids: 512,
    wallClockMs: 45 * 60 * 1000,
    extraHosts: ["host.docker.internal:host-gateway"],
    // The default coding model is OpenCode's Big Pickle: a free stealth model
    // served by the Console endpoint (not the Go one). The same workspace key
    // authenticates both, and the job's own `opencode run` is the client the
    // free tier admits. A deployment that wants a Go-plan model overrides both
    // this URL and the model; one that runs locally points both at the host and
    // leaves the key empty.
    model: "big-pickle",
    llmBaseUrl: "https://opencode.ai/inference/openai/v1",
    apiKey: "",
    // The broker (#141 phase 7): a job gets a derived token, never the key.
    // Loopback is the dev-safe bind (containers arrive on it through
    // host.docker.internal); compose overrides all three for its private
    // network.
    proxyBind: "127.0.0.1",
    proxyPort: 54322,
    proxyUrl: "http://host.docker.internal:54322/v1",
    proxySecret: "",
    proxyMaxRequestsPerJob: 500,
    network: "",
    // Operability (#141 phase 7): the full log lives beside the workspaces,
    // and nothing is kept forever. A successful workspace is the only copy of
    // its branch until #140 pushes it; logs outlive clones because a dead log
    // cannot be re-created.
    logRoot: "",
    logMaxMb: 10,
    workspaceRetentionDays: 14,
    logRetentionDays: 30,
    keepJobRows: 100,
} as const;

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
 * Server-side TTS settings (#83).
 *
 * Today only `"kokoro"` exists; the engine itself lives in `src/tts/` and is
 * an optional dependency, so enabling TTS here requires the package to be
 * installed (the prod Docker image installs `--omit=optional` and never
 * carries it). Model weights are downloaded on first synthesis into
 * `~/.jarvis/tts` (or `JARVIS_TTS_CACHE_DIR`) — never baked into an image.
 */
export interface TtsConfig {
    /** The synthesis engine (`JARVIS_TTS_PROVIDER`); `"kokoro"` today. */
    readonly provider: "kokoro";
    /** Kokoro voice id (`JARVIS_TTS_VOICE`), e.g. `bm_lewis`. */
    readonly voice: string;
    /** Speaking speed multiplier (`JARVIS_TTS_SPEED`), default `1`. */
    readonly speed: number;
    /**
     * Segmenter granularity (#89, `JARVIS_TTS_SEGMENT`): `"sentence"` (the
     * default) splits at sentence boundaries; `"clause"` additionally
     * splits at commas/semicolons so the first spoken audio lands earlier,
     * at the cost of prosody across the split.
     */
    readonly segment: "sentence" | "clause";
}

/** The upstream model archive the server fetches on first request. */
export const DEFAULT_STT_MODEL_URL =
    "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz";

/** Default cache location of the STT model archive (private, `0700`). */
export const DEFAULT_STT_MODEL_DIR = `${homedir()}/.jarvis/stt`;

/**
 * Local STT model serving (#84 P3b). The server fetches the WASM speech
 * engine's model archive from `modelUrl` on first request, caches it
 * privately under `modelDir`, and serves the cached file at
 * `GET /api/stt/model` — so browser clients run recognition on-device
 * without any external egress (the archive is open-source model weights,
 * never user data).
 */
export interface SttModelConfig {
    /** Where the archive is fetched from (`JARVIS_STT_MODEL_URL`). */
    readonly modelUrl: string;
    /** Where the archive caches (`JARVIS_STT_MODEL_DIR`). */
    readonly modelDir: string;
}

/** The upstream release hosting the openWakeWord ONNX models (v0.5.1). */
export const DEFAULT_WAKE_MODEL_URL =
    "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";

/** Default cache location of the wake-word models (private, `0700`). */
export const DEFAULT_WAKE_MODEL_DIR = `${homedir()}/.jarvis/wake`;

/**
 * Local wake-word model serving (#84 P4). The server fetches the
 * openWakeWord ONNX files (`melspectrogram.onnx`, `embedding_model.onnx`,
 * `hey_jarvis_v0.1.onnx`) from `baseUrl` on first request, caches them
 * privately under `modelDir`, and serves them at
 * `GET /api/wake/model/<file>` — so browser clients run wake-word detection
 * on-device without any external egress (the weights are open-source, never
 * user data) and without tripping over the upstream's missing CORS headers.
 */
export interface WakeModelConfig {
    /** Upstream base URL the files are fetched from (`JARVIS_WAKE_MODEL_URL`). */
    readonly baseUrl: string;
    /** Where the files cache (`JARVIS_WAKE_MODEL_DIR`). */
    readonly modelDir: string;
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

/**
 * Where a coding job's workspace lives when the caller does not say.
 *
 * Under the same private `~/.jarvis` tree as the database and checkpoints, so
 * one volume in the deployment is still all the durable state. Each job gets a
 * subdirectory named after its id; the sandbox mounts only that directory.
 */
export function defaultSandboxWorkspaceRoot(): string {
    return path.join(homedir(), ".jarvis", "jobs");
}

/**
 * Default home of a job's full log, beside the workspaces.
 *
 * Derived from the workspace root so a deployment that moves its jobs moves
 * the logs with them (and keeps both on the same volume).
 *
 * @param workspaceRoot - The resolved server-side workspace root.
 * @returns The directory job log files live in.
 */
export function defaultSandboxLogRoot(workspaceRoot: string): string {
    return path.join(path.dirname(workspaceRoot), "logs", "coding");
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
    "You are JARVIS, a helpful, personal AI assistant. " +
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
    // Port 0 is a legitimate setting (ephemeral bind), so the zero-ok
    // parser applies — anything else non-numeric falls back with a warning.
    return zeroOkOr("PORT", process.env.PORT, DEFAULT_PORT);
}

export function getLlmConfig(): LlmConfig {
    return {
        baseUrl: process.env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
        model: process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
        temperature: zeroOkOr(
            "LLM_TEMPERATURE",
            process.env.LLM_TEMPERATURE,
            DEFAULT_LLM_TEMPERATURE,
        ),
        streamUsage: false,
        systemPrompt: process.env.LLM_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
        agentMaxTurns: numberOr(
            "JARVIS_AGENT_MAX_TURNS",
            process.env.JARVIS_AGENT_MAX_TURNS,
            DEFAULT_AGENT_MAX_TURNS,
        ),
        checkpointPath:
            process.env.JARVIS_CHECKPOINT_PATH ?? defaultCheckpointPath(),
        vlModel: process.env.LLM_VL_MODEL ?? DEFAULT_LLM_VL_MODEL,
        vlMaxTokens: numberOr(
            "LLM_VL_MAX_TOKENS",
            process.env.LLM_VL_MAX_TOKENS,
            DEFAULT_LLM_VL_MAX_TOKENS,
        ),
        vlTimeoutMs: numberOr(
            "LLM_VL_TIMEOUT_MS",
            process.env.LLM_VL_TIMEOUT_MS,
            DEFAULT_LLM_VL_TIMEOUT_MS,
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
 * A GitHub App installation (#140).
 *
 * `privateKey` is the PEM content, not a path: the environment may carry it
 * inline (with `\n` escapes) or the server reads the file named by
 * `JARVIS_GITHUB_APP_PRIVATE_KEY_PATH` once at boot.
 */
export interface GitHubConfig {
    /** The App's numeric id (`JARVIS_GITHUB_APP_ID`). */
    readonly appId: string;
    /** The App's PEM private key. */
    readonly privateKey: string;
    /** The installation serving the allowlisted repositories. */
    readonly installationId: string;
    /** The REST host (`JARVIS_GITHUB_API_BASE_URL`), for a GitHub Enterprise install. */
    readonly apiBaseUrl: string;
    /**
     * The repositories the tracker tools may name (`JARVIS_GITHUB_REPOS`).
     *
     * Defaults to the coding sandbox's allowlist — the App is installed on
     * the same repositories, and one list is a fact rather than two copies of
     * it. Empty means the tools are not registered at all.
     */
    readonly repos: readonly string[];
}

/** Default GitHub REST host. */
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

/**
 * Reads the GitHub App settings, or nothing when any piece is absent.
 *
 * A half-configured App is treated as absent rather than failing the boot: the
 * sandbox still works, a finished branch simply stays local. The key may be
 * inline (`\n` escapes allowed) or at `JARVIS_GITHUB_APP_PRIVATE_KEY_PATH`.
 *
 * @returns The settings, or `null` when the integration is off.
 */
export function getGitHubConfig(): GitHubConfig | null {
    const appId = process.env.JARVIS_GITHUB_APP_ID?.trim() ?? "";
    const installationId =
        process.env.JARVIS_GITHUB_INSTALLATION_ID?.trim() ?? "";
    let privateKey =
        process.env.JARVIS_GITHUB_APP_PRIVATE_KEY?.trim().replace(
            /\\n/g,
            "\n",
        ) ?? "";
    const keyPath =
        process.env.JARVIS_GITHUB_APP_PRIVATE_KEY_PATH?.trim() ?? "";
    if (privateKey.length === 0 && keyPath.length > 0) {
        try {
            privateKey = readFileSync(keyPath, "utf8").trim();
        } catch {
            privateKey = "";
        }
    }
    if (
        appId.length === 0 ||
        installationId.length === 0 ||
        privateKey.length === 0
    ) {
        return null;
    }
    // The App id is the numeric one on the App's settings page. Its slug and
    // its client id are different values, and GitHub rejects either as a JWT
    // issuer — catching it here turns "every job fails to publish" into one
    // boot warning.
    if (!/^\d+$/.test(appId)) {
        logger.warn(
            "JARVIS_GITHUB_APP_ID is not numeric; GitHub publishing is off (use the App ID from the App's settings page, not its name)",
        );
        return null;
    }
    return {
        appId,
        installationId,
        privateKey,
        apiBaseUrl:
            process.env.JARVIS_GITHUB_API_BASE_URL?.trim() ||
            DEFAULT_GITHUB_API_BASE_URL,
        repos: parseCsv(
            process.env.JARVIS_GITHUB_REPOS ?? process.env.JARVIS_SANDBOX_REPOS,
        ),
    };
}

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
    /**
     * Notification settings (#139). Undefined when `JARVIS_NOTIFY=off`, which
     * unmounts the REST surface and the delivery wiring.
     */
    readonly notify?: NotifyConfig;
    /**
     * Scheduler settings (`JARVIS_JOB_*`); `undefined` disables the whole
     * surface (`JARVIS_SCHEDULER=off`), as `notify` does for notifications.
     */
    readonly scheduler?: SchedulerConfig;
    /**
     * Coding-sandbox settings (`JARVIS_SANDBOX=docker`); `undefined` means the
     * deployment has no container runtime configured, so no coding job may
     * start — the same "do not advertise what cannot be honoured" posture the
     * scheduler and notification surfaces take with their own switches.
     */
    readonly sandbox?: SandboxConfig;
    /**
     * Login/bootstrap throttle settings (`JARVIS_RATE_*`), default LAN values.
     */
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
     * GitHub App settings for publishing a finished coding job (#140).
     *
     * Present only when the App id, its private key and the installation are
     * all configured. An App rather than a personal token: the installation is
     * scoped to the repositories it was granted, its token lives an hour, and
     * nothing about it ever enters a job container — the host pushes and opens
     * the pull request. Without it a finished branch stays local and the job
     * keeps its workspace.
     */
    readonly github?: GitHubConfig;
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
     * Wikipedia lookup settings (#8), present unless `JARVIS_WIKIPEDIA=off`.
     * Unlike the other optional tools there is no credential to gate on, so
     * this is enabled by default; `undefined` means the `wikipedia` tool is
     * not registered at all. Optional so hand-built configs (tests) can omit
     * it.
     */
    readonly wikipedia?: WikipediaConfig;
    /**
     * Server-side TTS settings (#83), present only when a provider is
     * configured (`JARVIS_TTS_PROVIDER`) — unset means no synthesis at all:
     * sockets never see audio frames and the optional engine packages are
     * never imported. Optional so hand-built configs (tests) can omit it.
     */
    readonly tts?: TtsConfig;
    /**
     * Local STT model serving (#84 P3b), present only when configured
     * (`JARVIS_STT_PROVIDER=vosk`) — the client-side speech-recognition
     * engine downloads its model archive from the server so deployments
     * need no external egress for it. Unset means `GET /api/stt/model`
     * answers 404 and clients fall back to their other engines. Optional so
     * hand-built configs (tests) can omit it.
     */
    readonly stt?: SttModelConfig;
    /**
     * Local wake-word model serving (#84 P4), present only when configured
     * (`JARVIS_WAKE_PROVIDER=openwakeword`) — the client-side detector
     * downloads its three ONNX files from the server so deployments need no
     * external egress (and skirt the upstream's missing CORS headers).
     * Unset means `GET /api/wake/model/:file` answers 404 and the wake
     * toggle is unavailable. Optional so hand-built configs (tests) can
     * omit it.
     */
    readonly wake?: WakeModelConfig;
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
 * Normalizes a wiki language subdomain (`JARVIS_WIKIPEDIA_LANG`).
 *
 * The value is interpolated into a URL host (`https://<lang>.wikipedia.org`),
 * so it is validated rather than passed through: only a lowercase
 * alphanumeric/hyphen label is accepted, and anything else falls back to the
 * default with a warning. That keeps a typo — or a hostile value — from
 * redirecting the request to a different host.
 */
function wikiLang(raw: string | undefined): string {
    const value = (raw ?? "").trim().toLowerCase();
    if (value === "") {
        return DEFAULT_WIKIPEDIA_LANG;
    }
    if (/^[a-z][a-z0-9-]*$/.test(value)) {
        return value;
    }
    logger.warn(
        `JARVIS_WIKIPEDIA_LANG invalid (${JSON.stringify(raw)}); using ${DEFAULT_WIKIPEDIA_LANG}`,
    );
    return DEFAULT_WIKIPEDIA_LANG;
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

/**
 * Parses a positive numeric env var, falling back to the documented default
 * when the variable is unset or not a finite positive number.
 *
 * The repo's config posture is that a typo can never break the server start —
 * an unparseable value degrades to the default rather than throwing. Since a
 * silent fallback is exactly how a mistyped `JARVIS_TURN_TIMEOUT_MS` once
 * turned into NaN-driven behavior, an invalid **provided** value is also
 * announced with a `warn` naming the variable; an unset (or empty) variable
 * falls back quietly, because that is the normal default path.
 *
 * @param name - The env var's name, for the fallback warning.
 * @param raw - The raw env value, or `undefined` when unset.
 * @param fallback - The documented default.
 */
function numberOr(
    name: string,
    raw: string | undefined,
    fallback: number,
): number {
    if (raw === undefined || raw === "") {
        return fallback;
    }
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
        return value;
    }
    logger.warn(`${name} invalid (${JSON.stringify(raw)}); using ${fallback}`);
    return fallback;
}

/**
 * Splits a comma-separated environment list, trimming and dropping blanks.
 *
 * @param raw - The variable's value, or `undefined` when unset.
 * @returns The non-empty entries.
 */
function parseCsv(raw: string | undefined): string[] {
    return (raw ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/**
 * The extra `/etc/hosts` entries a job container gets.
 *
 * Unset keeps the default host-gateway alias — a job that cannot reach its
 * model cannot work — while `none` removes it for an engine that already
 * provides `host.docker.internal`.
 *
 * @param raw - `JARVIS_SANDBOX_EXTRA_HOSTS`, or `undefined` when unset.
 * @returns The entries to pass through.
 */
function parseExtraHosts(raw: string | undefined): string[] {
    if (raw === undefined) {
        return [...DEFAULT_SANDBOX_CONFIG.extraHosts];
    }
    if (raw.trim().toLowerCase() === "none") {
        return [];
    }
    return parseCsv(raw);
}

/**
 * Like {@link numberOr} but accepts 0, for knobs where zero is a real setting
 * rather than a missing one (the Home Assistant cache TTL: 0 disables
 * caching, which is how you debug against a live instance without stale
 * reads — or the LLM temperature, where 0 means fully deterministic).
 */
function zeroOkOr(
    name: string,
    raw: string | undefined,
    fallback: number,
): number {
    if (raw === undefined || raw === "") {
        return fallback;
    }
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) {
        return value;
    }
    logger.warn(`${name} invalid (${JSON.stringify(raw)}); using ${fallback}`);
    return fallback;
}

export function getAppConfig(): AppConfig {
    // One root, two views: a container deployment passes the host path the
    // daemon resolves bind sources against, which is not the server's path.
    const sandboxWorkspaceRoot =
        process.env.JARVIS_SANDBOX_WORKSPACE_ROOT ??
        defaultSandboxWorkspaceRoot();
    return {
        appDbPath: process.env.JARVIS_DB_PATH ?? defaultAppDbPath(),
        turnTimeoutMs: numberOr(
            "JARVIS_TURN_TIMEOUT_MS",
            process.env.JARVIS_TURN_TIMEOUT_MS,
            DEFAULT_TURN_TIMEOUT_MS,
        ),
        bootstrapToken: process.env.JARVIS_BOOTSTRAP_TOKEN || undefined,
        sessionTtlMs: numberOr(
            "JARVIS_SESSION_TTL_MS",
            process.env.JARVIS_SESSION_TTL_MS,
            DEFAULT_SESSION_TTL_MS,
        ),
        host: process.env.JARVIS_HOST ?? DEFAULT_HOST,
        tlsCertPath: process.env.JARVIS_TLS_CERT || undefined,
        tlsKeyPath: process.env.JARVIS_TLS_KEY || undefined,
        httpRedirectPort: process.env.JARVIS_HTTP_REDIRECT_PORT
            ? numberOr(
                  "JARVIS_HTTP_REDIRECT_PORT",
                  process.env.JARVIS_HTTP_REDIRECT_PORT,
                  0,
              ) || undefined
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
            windowMs: numberOr(
                "JARVIS_RATE_WINDOW_MS",
                process.env.JARVIS_RATE_WINDOW_MS,
                DEFAULT_RATE_LIMIT_CONFIG.windowMs,
            ),
            maxFailures: numberOr(
                "JARVIS_RATE_MAX_FAILURES",
                process.env.JARVIS_RATE_MAX_FAILURES,
                DEFAULT_RATE_LIMIT_CONFIG.maxFailures,
            ),
            lockoutMs: numberOr(
                "JARVIS_RATE_LOCKOUT_MS",
                process.env.JARVIS_RATE_LOCKOUT_MS,
                DEFAULT_RATE_LIMIT_CONFIG.lockoutMs,
            ),
            maxIpFailures: numberOr(
                "JARVIS_RATE_MAX_IP_FAILURES",
                process.env.JARVIS_RATE_MAX_IP_FAILURES,
                DEFAULT_RATE_LIMIT_CONFIG.maxIpFailures,
            ),
        },
        apiContractVerify: process.env.JARVIS_API_CONTRACT === "verify",
        notify:
            process.env.JARVIS_NOTIFY === "off"
                ? undefined
                : {
                      deliveriesPerMin: numberOr(
                          "JARVIS_NOTIFY_DELIVERIES_PER_MIN",
                          process.env.JARVIS_NOTIFY_DELIVERIES_PER_MIN,
                          DEFAULT_NOTIFY_CONFIG.deliveriesPerMin,
                      ),
                      maxPerUser: numberOr(
                          "JARVIS_NOTIFY_MAX_PER_USER",
                          process.env.JARVIS_NOTIFY_MAX_PER_USER,
                          DEFAULT_NOTIFY_CONFIG.maxPerUser,
                      ),
                  },
        scheduler:
            process.env.JARVIS_SCHEDULER === "off"
                ? undefined
                : {
                      tickMs: numberOr(
                          "JARVIS_JOB_TICK_MS",
                          process.env.JARVIS_JOB_TICK_MS,
                          DEFAULT_SCHEDULER_CONFIG.tickMs,
                      ),
                      maxPerUser: numberOr(
                          "JARVIS_JOB_MAX_PER_USER",
                          process.env.JARVIS_JOB_MAX_PER_USER,
                          DEFAULT_SCHEDULER_CONFIG.maxPerUser,
                      ),
                      maxLatenessMs: numberOr(
                          "JARVIS_JOB_MAX_LATENESS_MS",
                          process.env.JARVIS_JOB_MAX_LATENESS_MS,
                          DEFAULT_SCHEDULER_CONFIG.maxLatenessMs,
                      ),
                      maxPerTick: numberOr(
                          "JARVIS_JOB_MAX_PER_TICK",
                          process.env.JARVIS_JOB_MAX_PER_TICK,
                          DEFAULT_SCHEDULER_CONFIG.maxPerTick,
                      ),
                      maxHorizonDays: numberOr(
                          "JARVIS_JOB_MAX_HORIZON_DAYS",
                          process.env.JARVIS_JOB_MAX_HORIZON_DAYS,
                          DEFAULT_SCHEDULER_CONFIG.maxHorizonDays,
                      ),
                      modelRunsPerDay: numberOr(
                          "JARVIS_JOB_MODEL_RUNS_PER_DAY",
                          process.env.JARVIS_JOB_MODEL_RUNS_PER_DAY,
                          DEFAULT_SCHEDULER_CONFIG.modelRunsPerDay,
                      ),
                  },
        // Coding jobs (#141): enabled by an explicit `docker`. A deployment
        // with no daemon must not advertise a surface it cannot honour, and the
        // runner is built from this block only when it is present.
        sandbox:
            process.env.JARVIS_SANDBOX === "docker"
                ? (() => {
                      const proxyPort = numberOr(
                          "JARVIS_SANDBOX_PROXY_PORT",
                          process.env.JARVIS_SANDBOX_PROXY_PORT,
                          DEFAULT_SANDBOX_CONFIG.proxyPort,
                      );
                      return {
                          image:
                              process.env.JARVIS_SANDBOX_IMAGE ??
                              DEFAULT_SANDBOX_CONFIG.image,
                          socketPath:
                              process.env.JARVIS_SANDBOX_DOCKER_SOCKET ??
                              DEFAULT_SANDBOX_CONFIG.socketPath,
                          workspaceRoot: sandboxWorkspaceRoot,
                          // Equal to the server's view unless a container
                          // deployment says otherwise: the daemon resolves bind
                          // sources on the host, not inside the server.
                          workspaceHostRoot:
                              process.env.JARVIS_SANDBOX_WORKSPACE_HOST_ROOT ??
                              sandboxWorkspaceRoot,
                          maxJobs: numberOr(
                              "JARVIS_SANDBOX_MAX_JOBS",
                              process.env.JARVIS_SANDBOX_MAX_JOBS,
                              DEFAULT_SANDBOX_CONFIG.maxJobs,
                          ),
                          cpus: numberOr(
                              "JARVIS_SANDBOX_CPUS",
                              process.env.JARVIS_SANDBOX_CPUS,
                              DEFAULT_SANDBOX_CONFIG.cpus,
                          ),
                          memoryMb: numberOr(
                              "JARVIS_SANDBOX_MEMORY_MB",
                              process.env.JARVIS_SANDBOX_MEMORY_MB,
                              DEFAULT_SANDBOX_CONFIG.memoryMb,
                          ),
                          pids: numberOr(
                              "JARVIS_SANDBOX_PIDS",
                              process.env.JARVIS_SANDBOX_PIDS,
                              DEFAULT_SANDBOX_CONFIG.pids,
                          ),
                          // Minutes in the environment, milliseconds in the
                          // config: an operator thinks in minutes, the supervisor
                          // compares instants.
                          wallClockMs:
                              numberOr(
                                  "JARVIS_SANDBOX_WALL_CLOCK_MINUTES",
                                  process.env.JARVIS_SANDBOX_WALL_CLOCK_MINUTES,
                                  DEFAULT_SANDBOX_CONFIG.wallClockMs / 60_000,
                              ) * 60_000,
                          repos: parseCsv(process.env.JARVIS_SANDBOX_REPOS),
                          model:
                              process.env.JARVIS_SANDBOX_MODEL ??
                              DEFAULT_SANDBOX_CONFIG.model,
                          llmBaseUrl:
                              process.env.JARVIS_SANDBOX_LLM_BASE_URL ??
                              DEFAULT_SANDBOX_CONFIG.llmBaseUrl,
                          apiKey: process.env.JARVIS_SANDBOX_API_KEY ?? "",
                          extraHosts: parseExtraHosts(
                              process.env.JARVIS_SANDBOX_EXTRA_HOSTS,
                          ),
                          // The broker a job talks to instead of the provider: the
                          // key stays in this process. The URL defaults to the
                          // dev-safe host-gateway spelling and follows the port.
                          proxyBind:
                              process.env.JARVIS_SANDBOX_PROXY_BIND ??
                              DEFAULT_SANDBOX_CONFIG.proxyBind,
                          proxyPort,
                          proxyUrl:
                              process.env.JARVIS_SANDBOX_PROXY_URL ??
                              `http://host.docker.internal:${proxyPort}/v1`,
                          proxySecret:
                              process.env.JARVIS_SANDBOX_PROXY_SECRET ?? "",
                          proxyMaxRequestsPerJob: numberOr(
                              "JARVIS_SANDBOX_PROXY_MAX_REQUESTS",
                              process.env.JARVIS_SANDBOX_PROXY_MAX_REQUESTS,
                              DEFAULT_SANDBOX_CONFIG.proxyMaxRequestsPerJob,
                          ),
                          network: process.env.JARVIS_SANDBOX_NETWORK ?? "",
                          logRoot:
                              process.env.JARVIS_SANDBOX_LOG_ROOT ??
                              defaultSandboxLogRoot(sandboxWorkspaceRoot),
                          logMaxMb: numberOr(
                              "JARVIS_SANDBOX_LOG_MAX_MB",
                              process.env.JARVIS_SANDBOX_LOG_MAX_MB,
                              DEFAULT_SANDBOX_CONFIG.logMaxMb,
                          ),
                          workspaceRetentionDays: numberOr(
                              "JARVIS_SANDBOX_WORKSPACE_RETENTION_DAYS",
                              process.env
                                  .JARVIS_SANDBOX_WORKSPACE_RETENTION_DAYS,
                              DEFAULT_SANDBOX_CONFIG.workspaceRetentionDays,
                          ),
                          logRetentionDays: numberOr(
                              "JARVIS_SANDBOX_LOG_RETENTION_DAYS",
                              process.env.JARVIS_SANDBOX_LOG_RETENTION_DAYS,
                              DEFAULT_SANDBOX_CONFIG.logRetentionDays,
                          ),
                          keepJobRows: numberOr(
                              "JARVIS_SANDBOX_KEEP_JOB_ROWS",
                              process.env.JARVIS_SANDBOX_KEEP_JOB_ROWS,
                              DEFAULT_SANDBOX_CONFIG.keepJobRows,
                          ),
                      };
                  })()
                : undefined,
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
                          "JARVIS_ATTACHMENT_MAX_BYTES",
                          process.env.JARVIS_ATTACHMENT_MAX_BYTES,
                          DEFAULT_ATTACHMENT_MAX_BYTES,
                      ),
                      maxTotalBytes: numberOr(
                          "JARVIS_ATTACHMENT_MAX_TOTAL_BYTES",
                          process.env.JARVIS_ATTACHMENT_MAX_TOTAL_BYTES,
                          DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES,
                      ),
                      vlCallsPerMin: numberOr(
                          "JARVIS_ATTACHMENT_VL_CALLS_PER_MIN",
                          process.env.JARVIS_ATTACHMENT_VL_CALLS_PER_MIN,
                          DEFAULT_ATTACHMENT_VL_CALLS_PER_MIN,
                      ),
                      maxInflight: numberOr(
                          "JARVIS_ATTACHMENT_MAX_INFLIGHT",
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
                          "JARVIS_SEARCH_TIMEOUT_MS",
                          process.env.JARVIS_SEARCH_TIMEOUT_MS,
                          DEFAULT_SEARCH_TIMEOUT_MS,
                      ),
                      maxResults: numberOr(
                          "JARVIS_SEARCH_MAX_RESULTS",
                          process.env.JARVIS_SEARCH_MAX_RESULTS,
                          DEFAULT_SEARCH_MAX_RESULTS,
                      ),
                      callsPerMin: numberOr(
                          "JARVIS_SEARCH_CALLS_PER_MIN",
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
                      "JARVIS_WEATHER_TIMEOUT_MS",
                      process.env.JARVIS_WEATHER_TIMEOUT_MS,
                      DEFAULT_WEATHER_TIMEOUT_MS,
                  ),
                  callsPerMin: numberOr(
                      "JARVIS_WEATHER_CALLS_PER_MIN",
                      process.env.JARVIS_WEATHER_CALLS_PER_MIN,
                      DEFAULT_WEATHER_CALLS_PER_MIN,
                  ),
              },
        wikipedia:
            process.env.JARVIS_WIKIPEDIA === "off"
                ? undefined
                : {
                      lang: wikiLang(process.env.JARVIS_WIKIPEDIA_LANG),
                      timeoutMs: numberOr(
                          "JARVIS_WIKIPEDIA_TIMEOUT_MS",
                          process.env.JARVIS_WIKIPEDIA_TIMEOUT_MS,
                          DEFAULT_WIKIPEDIA_TIMEOUT_MS,
                      ),
                      maxSentences: numberOr(
                          "JARVIS_WIKIPEDIA_MAX_SENTENCES",
                          process.env.JARVIS_WIKIPEDIA_MAX_SENTENCES,
                          DEFAULT_WIKIPEDIA_MAX_SENTENCES,
                      ),
                      maxFullChars: numberOr(
                          "JARVIS_WIKIPEDIA_MAX_FULL_CHARS",
                          process.env.JARVIS_WIKIPEDIA_MAX_FULL_CHARS,
                          DEFAULT_WIKIPEDIA_MAX_FULL_CHARS,
                      ),
                      maxCandidates: numberOr(
                          "JARVIS_WIKIPEDIA_MAX_CANDIDATES",
                          process.env.JARVIS_WIKIPEDIA_MAX_CANDIDATES,
                          DEFAULT_WIKIPEDIA_MAX_CANDIDATES,
                      ),
                      callsPerMin: numberOr(
                          "JARVIS_WIKIPEDIA_CALLS_PER_MIN",
                          process.env.JARVIS_WIKIPEDIA_CALLS_PER_MIN,
                          DEFAULT_WIKIPEDIA_CALLS_PER_MIN,
                      ),
                      guestSessionPerMin: numberOr(
                          "JARVIS_WIKIPEDIA_GUEST_SESSION_PER_MIN",
                          process.env.JARVIS_WIKIPEDIA_GUEST_SESSION_PER_MIN,
                          DEFAULT_WIKIPEDIA_GUEST_SESSION_PER_MIN,
                      ),
                      guestIpPerMin: numberOr(
                          "JARVIS_WIKIPEDIA_GUEST_IP_PER_MIN",
                          process.env.JARVIS_WIKIPEDIA_GUEST_IP_PER_MIN,
                          DEFAULT_WIKIPEDIA_GUEST_IP_PER_MIN,
                      ),
                      userAgent:
                          process.env.JARVIS_WIKIPEDIA_USER_AGENT ||
                          DEFAULT_WIKIPEDIA_USER_AGENT,
                  },
        github: getGitHubConfig() ?? undefined,
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
                          "JARVIS_HA_CALLS_PER_MIN",
                          process.env.JARVIS_HA_CALLS_PER_MIN,
                          DEFAULT_HA_CALLS_PER_MIN,
                      ),
                      timeoutMs: numberOr(
                          "JARVIS_HA_TIMEOUT_MS",
                          process.env.JARVIS_HA_TIMEOUT_MS,
                          DEFAULT_HA_TIMEOUT_MS,
                      ),
                      // 0 is allowed: it turns the snapshot cache off.
                      cacheTtlMs: zeroOkOr(
                          "JARVIS_HA_CACHE_TTL_MS",
                          process.env.JARVIS_HA_CACHE_TTL_MS,
                          DEFAULT_HA_CACHE_TTL_MS,
                      ),
                      listLimit: numberOr(
                          "JARVIS_HA_LIST_LIMIT",
                          process.env.JARVIS_HA_LIST_LIMIT,
                          DEFAULT_HA_LIST_LIMIT,
                      ),
                      // Lowercased so the matcher never compares case.
                      lightTokens:
                          csv(process.env.JARVIS_HA_LIGHT_TOKENS)?.map(
                              (token) => token.toLowerCase(),
                          ) ?? DEFAULT_HA_LIGHT_TOKENS,
                  },
        tts:
            process.env.JARVIS_TTS_PROVIDER === "kokoro"
                ? {
                      provider: "kokoro",
                      voice:
                          process.env.JARVIS_TTS_VOICE || DEFAULT_KOKORO_VOICE,
                      speed: numberOr(
                          "JARVIS_TTS_SPEED",
                          process.env.JARVIS_TTS_SPEED,
                          1,
                      ),
                      segment:
                          process.env.JARVIS_TTS_SEGMENT === "clause"
                              ? "clause"
                              : "sentence",
                  }
                : undefined,
        stt:
            process.env.JARVIS_STT_PROVIDER === "vosk"
                ? {
                      modelUrl:
                          process.env.JARVIS_STT_MODEL_URL ||
                          DEFAULT_STT_MODEL_URL,
                      modelDir:
                          process.env.JARVIS_STT_MODEL_DIR ||
                          DEFAULT_STT_MODEL_DIR,
                  }
                : undefined,
        wake:
            process.env.JARVIS_WAKE_PROVIDER === "openwakeword"
                ? {
                      baseUrl:
                          process.env.JARVIS_WAKE_MODEL_URL ||
                          DEFAULT_WAKE_MODEL_URL,
                      modelDir:
                          process.env.JARVIS_WAKE_MODEL_DIR ||
                          DEFAULT_WAKE_MODEL_DIR,
                  }
                : undefined,
        corsOrigins: csv(process.env.JARVIS_CORS_ORIGINS)?.map(normalizeOrigin),
        trustProxyCidrs: csv(process.env.JARVIS_TRUST_PROXY_CIDRS)?.map(
            (cidr) => cidr.toLowerCase(),
        ),
    };
}
