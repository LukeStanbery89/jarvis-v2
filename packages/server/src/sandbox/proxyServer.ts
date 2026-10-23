/**
 * The broker sidecar's entrypoint (#141).
 *
 * The job's network is `--internal`: no route out, no DNS. This process is the
 * only container on that network with a second network card, so it is the
 * job's one door — the credential broker on one port, the forward proxy on
 * another.
 *
 * It is deliberately a separate process from the server:
 *
 *  - the server must not sit on the job's internal network (a job could then
 *    reach its API), so the broker cannot live in the server any more;
 *  - the sidecar has no database, so it asks the server whether a job is still
 *    running, presenting the job's own token (`GET /internal/job-state`);
 *  - the HMAC secret is read from the same private file the server writes, so
 *    a job's derived token verifies on both sides and survives restarts.
 *
 * Environment (all optional; the compose service and the dev script set the
 * ones that matter):
 *
 *   JARVIS_PROXY_PORT             broker port (54322)
 *   JARVIS_PROXY_EGRESS_PORT      forward-proxy port (54323)
 *   JARVIS_PROXY_EGRESS_POLICY    `public` (default), `allowlist`, `open`, `none`
 *   JARVIS_PROXY_EGRESS_HOSTS     comma-separated allowlist for `allowlist`
 *   JARVIS_PROXY_UPSTREAM_BASE_URL, JARVIS_PROXY_MODELS, JARVIS_PROXY_API_KEY
 *                                 (JARVIS_PROXY_MODEL is the older one-model
 *                                 spelling; MODELS is the ladder)
 *   JARVIS_PROXY_SECRET           or JARVIS_PROXY_SECRET_PATH
 *   JARVIS_PROXY_STATUS_URL       the server base (http://host.docker.internal:54321)
 *   JARVIS_PROXY_MAX_REQUESTS     per-job cap (500)
 */
import { homedir } from "node:os";
import path from "node:path";
import { logger } from "../logger";
import {
    createEgressProxy,
    type EgressPolicy,
    type EgressProxy,
} from "./egress";
import {
    createSandboxProxy,
    readProxySecret,
    type SandboxProxy,
} from "./proxy";

/** The sidecar's egress modes: the proxy's three, plus "no research at all". */
export type SidecarEgressPolicy = EgressPolicy | "none";

/** Everything the sidecar reads from its environment. */
export interface ProxyServerConfig {
    readonly bind: string;
    readonly port: number;
    readonly egressPort: number;
    readonly egressPolicy: SidecarEgressPolicy;
    readonly egressHosts: readonly string[];
    readonly upstreamBaseUrl: string;
    /** The models a job may ask for; the deployment's fallback ladder. */
    readonly models: readonly string[];
    readonly apiKey: string;
    /** `null` when neither the environment nor the private file supplied one. */
    readonly secret: string | null;
    readonly statusUrl: string;
    readonly maxRequestsPerJob: number;
}

/** Reads a positive integer, falling back when unset or malformed. */
function numberOr(
    name: string,
    raw: string | undefined,
    fallback: number,
): number {
    if (raw === undefined || raw.trim().length === 0) {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        logger.warn(`${name} is not a positive integer; using ${fallback}`);
        return fallback;
    }
    return value;
}

/** Reads a comma-separated list. */
function parseCsv(raw: string | undefined): string[] {
    return (raw ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/** Reads the egress policy, warning on a value it does not know. */
function parseEgressPolicy(raw: string | undefined): SidecarEgressPolicy {
    const value = (raw ?? "public").trim().toLowerCase();
    if (
        value === "public" ||
        value === "allowlist" ||
        value === "open" ||
        value === "none"
    ) {
        return value;
    }
    logger.warn(`unknown JARVIS_PROXY_EGRESS_POLICY "${value}"; using public`);
    return "public";
}

/**
 * Reads the sidecar's configuration.
 *
 * @param env - The process environment (tests pass a literal).
 * @returns The configuration, with `secret: null` when none was found.
 */
export function readProxyServerConfig(
    env: NodeJS.ProcessEnv = process.env,
): ProxyServerConfig {
    const secretPath =
        env.JARVIS_PROXY_SECRET_PATH?.trim() ||
        path.join(homedir(), ".jarvis", "sandbox-proxy.key");
    const configuredSecret = env.JARVIS_PROXY_SECRET?.trim() ?? "";
    const secret =
        configuredSecret.length >= 32
            ? configuredSecret
            : readProxySecret(secretPath);
    // `JARVIS_PROXY_MODEL` is the older, one-model spelling: keep it working,
    // but the ladder is what a deployment with a fallback sets. A rung may
    // carry `@limit` (the agent's context budget) — it is the same string the
    // server's `JARVIS_SANDBOX_MODELS` uses, and the broker only pins ids, so
    // the suffix is dropped here rather than requiring every deployment to
    // keep two spellings in sync.
    const models = parseCsv(
        env.JARVIS_PROXY_MODELS?.trim()
            ? env.JARVIS_PROXY_MODELS
            : env.JARVIS_PROXY_MODEL,
    )
        .map((entry) => entry.split("@")[0]?.trim() ?? "")
        .filter((entry) => entry.length > 0);
    return {
        bind: env.JARVIS_PROXY_BIND?.trim() || "0.0.0.0",
        port: numberOr("JARVIS_PROXY_PORT", env.JARVIS_PROXY_PORT, 54322),
        egressPort: numberOr(
            "JARVIS_PROXY_EGRESS_PORT",
            env.JARVIS_PROXY_EGRESS_PORT,
            54323,
        ),
        egressPolicy: parseEgressPolicy(env.JARVIS_PROXY_EGRESS_POLICY),
        egressHosts: parseCsv(env.JARVIS_PROXY_EGRESS_HOSTS),
        upstreamBaseUrl:
            env.JARVIS_PROXY_UPSTREAM_BASE_URL?.trim() ||
            "https://opencode.ai/inference/openai/v1",
        models: models.length > 0 ? models : ["big-pickle"],
        apiKey: env.JARVIS_PROXY_API_KEY ?? "",
        secret,
        statusUrl:
            env.JARVIS_PROXY_STATUS_URL?.trim() ||
            "http://host.docker.internal:54321",
        maxRequestsPerJob: numberOr(
            "JARVIS_PROXY_MAX_REQUESTS",
            env.JARVIS_PROXY_MAX_REQUESTS,
            500,
        ),
    };
}

/**
 * Builds the job-state check the broker calls before forwarding.
 *
 * The sidecar has no ledger. It presents the job's own token to the server,
 * which verifies it and answers from the database; the answer is cached for a
 * second so a burst of model calls is not a burst of HTTP. Any failure —
 * network, non-2xx, malformed body — is **false**: a broker that cannot prove
 * a job is alive must not spend its key on it.
 *
 * @param statusUrl - The server's base URL.
 * @param options - Fetch, clock and cache TTL (tests replace them).
 * @returns The check.
 */
export function createJobStateCheck(
    statusUrl: string,
    options: {
        fetch?: typeof fetch;
        now?: () => number;
        ttlMs?: number;
    } = {},
): (jobId: string, token: string) => Promise<boolean> {
    const fetchImpl = options.fetch ?? fetch;
    const now = options.now ?? (() => Date.now());
    const ttlMs = options.ttlMs ?? 1_000;
    const base = statusUrl.replace(/\/+$/, "");
    const cache = new Map<string, { at: number; active: boolean }>();

    return async (jobId, token): Promise<boolean> => {
        const at = now();
        const hit = cache.get(jobId);
        if (hit !== undefined && at - hit.at < ttlMs) {
            return hit.active;
        }
        try {
            const response = await fetchImpl(`${base}/internal/job-state`, {
                headers: {
                    authorization: `Bearer ${token}`,
                    accept: "application/json",
                },
                signal: AbortSignal.timeout(2_000),
            });
            if (!response.ok) {
                logger.warn(
                    `proxy sidecar: job-state check failed with ${response.status}`,
                );
                return false;
            }
            const body = (await response.json()) as { active?: unknown };
            const active = body.active === true;
            cache.set(jobId, { at, active });
            return active;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`proxy sidecar: job-state check failed: ${message}`);
            return false;
        }
    };
}

/**
 * Starts the broker and (unless disabled) the egress proxy.
 *
 * @param env - The environment (tests pass a literal).
 * @returns The running proxies, and a close function.
 */
export async function startProxySidecar(
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ close(): Promise<void> }> {
    const config = readProxyServerConfig(env);
    if (config.secret === null) {
        throw new Error(
            `no proxy secret at ${env.JARVIS_PROXY_SECRET_PATH ?? "~/.jarvis/sandbox-proxy.key"}; start the server once to create it, or set JARVIS_PROXY_SECRET`,
        );
    }
    const isJobActive = createJobStateCheck(config.statusUrl);
    const broker: SandboxProxy = createSandboxProxy({
        bind: config.bind,
        port: config.port,
        url: `http://proxy:${config.port}/v1`,
        secret: config.secret,
        upstreamBaseUrl: config.upstreamBaseUrl,
        models: config.models,
        apiKey: config.apiKey,
        maxRequestsPerJob: config.maxRequestsPerJob,
        isJobActive: (jobId, token) => isJobActive(jobId, token),
    });
    const brokerPort = await broker.start();

    let egress: EgressProxy | null = null;
    let egressPort: number | null = null;
    if (config.egressPolicy !== "none") {
        egress = createEgressProxy({
            bind: config.bind,
            port: config.egressPort,
            policy: config.egressPolicy,
            hosts: config.egressHosts,
            onDecision: (event) => {
                if (event.allowed) {
                    logger.debug(`egress: ${event.host}:${event.port} allowed`);
                } else {
                    logger.warn(
                        `egress: ${event.host}:${event.port} denied (${event.reason ?? "policy"})`,
                    );
                }
            },
        });
        egressPort = await egress.start();
    }

    logger.info(
        `sandbox proxy sidecar: broker=:${brokerPort}, egress=${
            egressPort === null ? "off" : `:${egressPort}`
        } (${config.egressPolicy}${
            config.egressHosts.length > 0
                ? `, ${config.egressHosts.length} host(s)`
                : ""
        }), models=${config.models.join(
            " -> ",
        )}, apiKey=${config.apiKey.length > 0 ? "set" : "unset"}, status=${
            config.statusUrl
        }`,
    );

    return {
        async close(): Promise<void> {
            if (egress !== null) {
                await egress.close();
            }
            await broker.close();
        },
    };
}

/* istanbul ignore next -- the process entry, not a unit under test */
if (require.main === module) {
    void startProxySidecar()
        .then((sidecar) => {
            const shutdown = (): void => {
                void sidecar.close().then(() => {
                    process.exit(0);
                });
            };
            process.on("SIGTERM", shutdown);
            process.on("SIGINT", shutdown);
        })
        .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`proxy sidecar failed to start: ${message}`);
            process.exitCode = 1;
        });
}
