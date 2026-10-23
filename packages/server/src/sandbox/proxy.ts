/**
 * The sandbox credential broker (#141 phase 7).
 *
 * A coding container must never hold the provider key: the agent runs
 * model-directed code with network access, so anything in its environment is
 * one prompt injection away from leaving with it. This module is the hole that
 * closes: the server keeps the real key and listens on a private port, and each
 * job is handed a **token derived from its own id** instead.
 *
 * The token is not a general bearer. It is
 * `jv1.<jobId>.<HMAC(secret, jobId)>`, so the broker learns which job is
 * calling from the token itself, and every request re-checks the ledger: a job
 * that has settled, been cancelled, or been pruned is refused immediately even
 * if its token leaked. The secret is stable across restarts (a file beside the
 * database unless the environment supplies one), so a `resume` job that
 * outlived the server keeps working.
 *
 * What this does **not** do is separate one container from another by network
 * address: on OrbStack a container's request arrives as `127.0.0.1`, so the
 * token is the identity. That is why it is per job, state-checked, scoped to
 * one model and one route, and capped.
 *
 * Placement is deployment-specific and deliberately boring:
 *
 *   - dev: bind `127.0.0.1` — containers reach it through
 *     `host.docker.internal`, the LAN cannot;
 *   - compose: an unpublished port on a private network shared with the job
 *     containers (`http://jarvis:54322/v1`), so nothing outside that network
 *     can even open a socket.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { logger } from "../logger";

/** The token version prefix; a future format can coexist with `jv1`. */
const TOKEN_PREFIX = "jv1";

/** Job ids are directory names and token claims, so keep them boring. */
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A chat-completions request is a prompt plus context; 8 MiB is generous. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Above this many live counters, drop the ones nobody has used for this long. */
const COUNTER_PRUNE_THRESHOLD = 32;
const COUNTER_TTL_MS = 60 * 60 * 1000;

/** The path prefix the job's provider base URL ends with. */
const PROXY_PREFIX = "/v1";

/** The request paths a job's agent may use, and the methods it may use them with. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    "/v1/chat/completions": ["POST"],
    "/v1/models": ["GET"],
};

/** Headers forwarded from the job to the upstream provider. */
const FORWARDED_HEADERS = [
    "accept",
    "content-type",
    "user-agent",
    "x-opencode-session",
] as const;

/** What the broker needs to serve one deployment's jobs. */
export interface SandboxProxyOptions {
    /** Interface to listen on (`JARVIS_SANDBOX_PROXY_BIND`). */
    bind: string;
    /** Port to listen on (`JARVIS_SANDBOX_PROXY_PORT`). */
    port: number;
    /** The URL jobs are configured with, for the boot line only. */
    url: string;
    /** The HMAC secret; stable across restarts. */
    secret: string;
    /** The real OpenAI-compatible endpoint the broker forwards to. */
    upstreamBaseUrl: string;
    /**
     * The models a job may ask for: the deployment's ladder, in order.
     *
     * The broker is not a model-quality gate, but it is a pin — a container
     * that could name any model could spend an account's budget on one it was
     * never given. An allowlist keeps the fallback rungs usable without
     * widening that.
     */
    models: readonly string[];
    /** The real provider key; empty for a local upstream. */
    apiKey: string;
    /** Accepted requests per job before the broker refuses (`429`). */
    maxRequestsPerJob: number;
    /**
     * Whether a job may still use the broker.
     *
     * Consulted per request, so a settle, cancel or prune revokes the token
     * without any coordination with the supervisor. The token is passed along
     * because a sidecar has no ledger: it asks the server with the same
     * credential the job presented, and caches the answer briefly.
     */
    isJobActive(jobId: string, token: string): boolean | Promise<boolean>;
}

/** The broker's lifecycle: start once, close for tests. */
export interface SandboxProxy {
    /**
     * Binds the listener.
     *
     * @returns The bound port (the configured one, or the ephemeral one in
     * tests when `port` is `0`).
     */
    start(): Promise<number>;
    /** Stops accepting and closes live connections. */
    close(): Promise<void>;
}

/**
 * Derives a job's broker token.
 *
 * Derived rather than stored: nothing to leak from the database, and the same
 * job id plus secret always yields the same token, so a resumed job's
 * container keeps working after a server restart.
 *
 * @param secret - The deployment's proxy secret.
 * @param jobId - The coding job id.
 * @returns The token handed to the job's container.
 */
export function deriveJobToken(secret: string, jobId: string): string {
    const signature = createHmac("sha256", secret)
        .update(jobId)
        .digest("base64url");
    return `${TOKEN_PREFIX}.${jobId}.${signature}`;
}

/**
 * Verifies a broker token and extracts its job id.
 *
 * @param secret - The deployment's proxy secret.
 * @param token - The `Authorization` bearer value.
 * @returns The claimed job id, or `null` for any malformed or forged token.
 */
export function verifyJobToken(secret: string, token: string): string | null {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
        return null;
    }
    const jobId = parts[1] ?? "";
    const provided = parts[2] ?? "";
    if (!JOB_ID_PATTERN.test(jobId) || provided.length === 0) {
        return null;
    }
    const expected = createHmac("sha256", secret)
        .update(jobId)
        .digest("base64url");
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
        return null;
    }
    return jobId;
}

/**
 * Resolves the HMAC secret, creating and persisting one on first boot.
 *
 * Persistence is load-bearing: a `resume` job's container holds a token signed
 * with the previous process's secret, so a fresh random secret per boot would
 * strand every adopted job at its first model call.
 *
 * @param configured - `JARVIS_SANDBOX_PROXY_SECRET`, or empty to use the file.
 * @param path - The private file beside the database.
 * @returns A secret of at least 32 characters.
 * @throws When the configured secret is shorter than 32 characters.
 */
export function readProxySecret(path: string): string | null {
    try {
        const stored = readFileSync(path, "utf8").trim();
        return stored.length >= 32 ? stored : null;
    } catch {
        return null;
    }
}

export function loadProxySecret(configured: string, path: string): string {
    const value = configured.trim();
    if (value.length > 0) {
        if (value.length < 32) {
            throw new Error(
                "JARVIS_SANDBOX_PROXY_SECRET must be at least 32 characters",
            );
        }
        return value;
    }
    try {
        const stored = readFileSync(path, "utf8").trim();
        if (stored.length >= 32) {
            return stored;
        }
    } catch {
        // First boot: there is no file yet.
    }
    const generated = randomBytes(32).toString("base64url");
    writeFileSync(path, `${generated}\n`, { mode: 0o600 });
    // The sidecar runs the broker without the auth package, so this little
    // posture helper is local rather than imported from it.
    try {
        chmodSync(path, 0o600);
    } catch {
        // Best-effort: only meaningful for a file this process created.
    }
    return generated;
}

/**
 * Builds the credential broker.
 *
 * Every refusal is a JSON `{ error: { message } }` shaped like an
 * OpenAI-compatible error, because the client on the other side is an SDK that
 * will surface `message` to the agent. None of them names the token, the secret
 * or the upstream key.
 *
 * @param options - The listener, upstream and policy configuration.
 * @returns The proxy lifecycle.
 */
export function createSandboxProxy(options: SandboxProxyOptions): SandboxProxy {
    const counts = new Map<string, number>();
    const lastSeen = new Map<string, number>();
    let server: Server | null = null;

    const upstreamBase = options.upstreamBaseUrl.endsWith("/")
        ? options.upstreamBaseUrl
        : `${options.upstreamBaseUrl}/`;

    /** Writes one JSON error without ever echoing a credential. */
    function fail(
        res: ServerResponse,
        status: number,
        message: string,
        type = "invalid_request_error",
    ): void {
        const body = JSON.stringify({ error: { message, type } });
        res.writeHead(status, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
        });
        res.end(body);
    }

    /** The bearer value, or `null` when the header is absent or not bearer-shaped. */
    function bearer(req: IncomingMessage): string | null {
        const header = req.headers.authorization;
        if (typeof header !== "string") {
            return null;
        }
        const match = /^Bearer\s+(.+)$/i.exec(header.trim());
        return match?.[1]?.trim() ?? null;
    }

    /**
     * Reads a request body, refusing instead of buffering without bound.
     *
     * @returns The bytes, or `null` when the body exceeded the limit.
     */
    async function readBody(req: IncomingMessage): Promise<Buffer | null> {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > MAX_BODY_BYTES) {
                return null;
            }
            chunks.push(buffer);
        }
        return Buffer.concat(chunks);
    }

    /**
     * Drops counters nobody has touched for an hour, so the map cannot grow.
     *
     * Time-based rather than ledger-based because a sidecar has no ledger: the
     * ledger check is per request, and a job cannot idle longer than its wall
     * clock while still spending requests.
     */
    function pruneCounters(now: number): void {
        if (counts.size <= COUNTER_PRUNE_THRESHOLD) {
            return;
        }
        for (const [jobId, at] of lastSeen) {
            if (now - at > COUNTER_TTL_MS) {
                counts.delete(jobId);
                lastSeen.delete(jobId);
            }
        }
    }

    /** Handles one already-authorized request. */
    async function forward(
        req: IncomingMessage,
        res: ServerResponse,
        path: string,
        jobId: string,
    ): Promise<void> {
        const used = counts.get(jobId) ?? 0;
        if (used >= options.maxRequestsPerJob) {
            fail(
                res,
                429,
                `this coding job has reached its ${options.maxRequestsPerJob}-request model budget`,
                "insufficient_quota",
            );
            return;
        }

        let body: Buffer | null = null;
        if (req.method === "POST") {
            body = await readBody(req);
            if (body === null) {
                fail(res, 413, "the request body is too large");
                req.destroy();
                return;
            }
            let parsed: { model?: unknown };
            try {
                parsed = JSON.parse(body.toString("utf8")) as {
                    model?: unknown;
                };
            } catch {
                fail(res, 400, "the request body is not valid JSON");
                return;
            }
            if (
                typeof parsed.model !== "string" ||
                !options.models.includes(parsed.model)
            ) {
                fail(
                    res,
                    403,
                    `this coding job may only use ${
                        options.models.length === 1
                            ? `the model ${options.models[0]}`
                            : `the models ${options.models.join(", ")}`
                    }`,
                    "permission_error",
                );
                return;
            }
        }

        counts.set(jobId, used + 1);
        lastSeen.set(jobId, Date.now());
        pruneCounters(Date.now());

        const headers: Record<string, string> = {};
        for (const name of FORWARDED_HEADERS) {
            const value = req.headers[name];
            if (typeof value === "string" && value.length > 0) {
                headers[name] = value;
            }
        }
        if (options.apiKey.length > 0) {
            headers.authorization = `Bearer ${options.apiKey}`;
        }

        // The job's base URL ends in `/v1`, and the upstream's base path may
        // carry its own prefix (`/inference/openai/v1`). Resolve the *suffix*
        // against the base rather than the absolute request path, which would
        // discard the upstream prefix and land on the provider's website.
        const relative = path.startsWith(`${PROXY_PREFIX}/`)
            ? path.slice(PROXY_PREFIX.length + 1)
            : path.slice(1);
        const target = new URL(relative, upstreamBase);
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.on("close", abort);

        const startedAt = Date.now();
        try {
            const upstream = await fetch(target, {
                method: req.method,
                headers,
                ...(body !== null ? { body } : {}),
                signal: controller.signal,
            });
            const responseHeaders: Record<string, string> = {};
            const contentType = upstream.headers.get("content-type");
            if (contentType !== null) {
                responseHeaders["content-type"] = contentType;
            }
            const cacheControl = upstream.headers.get("cache-control");
            if (cacheControl !== null) {
                responseHeaders["cache-control"] = cacheControl;
            }
            res.writeHead(upstream.status, responseHeaders);
            if (upstream.body === null) {
                res.end();
            } else {
                Readable.fromWeb(
                    upstream.body as import("node:stream/web").ReadableStream,
                ).pipe(res);
            }
            logger.debug(
                `sandbox proxy: job=${jobId} ${req.method} ${path} -> ${upstream.status} in ${Date.now() - startedAt}ms`,
            );
        } catch (err) {
            if (controller.signal.aborted) {
                // The job's client hung up; there is nobody to answer.
                return;
            }
            logger.warn(
                `sandbox proxy: job=${jobId} -> upstream failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            if (!res.headersSent) {
                fail(
                    res,
                    502,
                    "the model endpoint could not be reached",
                    "api_error",
                );
            } else {
                res.destroy();
            }
        } finally {
            res.off("close", abort);
        }
    }

    /** Handles one connection: route, authenticate, then forward. */
    async function handle(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        const path = (req.url ?? "").split("?")[0] ?? "";
        const methods = ALLOWED[path];
        if (methods === undefined) {
            fail(res, 404, "not found");
            return;
        }
        if (!methods.includes(req.method ?? "")) {
            fail(res, 405, `method ${req.method ?? "?"} is not allowed`);
            return;
        }

        const token = bearer(req);
        const claimed =
            token === null ? null : verifyJobToken(options.secret, token);
        if (claimed === null || token === null) {
            fail(
                res,
                401,
                "a valid coding-job token is required",
                "auth_error",
            );
            return;
        }
        if (!(await options.isJobActive(claimed, token))) {
            fail(
                res,
                401,
                "this coding job is no longer running",
                "auth_error",
            );
            return;
        }

        await forward(req, res, path, claimed);
    }

    return {
        async start(): Promise<number> {
            const created = createServer((req, res) => {
                void handle(req, res).catch((err: unknown) => {
                    logger.warn(
                        `sandbox proxy: unhandled request failure: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                    if (!res.headersSent) {
                        fail(res, 500, "the model broker failed");
                    } else {
                        res.destroy();
                    }
                });
            });
            // Long model turns are normal; the body budget is the bound that
            // matters, not a short request timeout.
            created.requestTimeout = 120_000;
            created.headersTimeout = 30_000;
            server = created;
            await new Promise<void>((resolve, reject) => {
                created.once("error", reject);
                created.listen(options.port, options.bind, () => {
                    created.off("error", reject);
                    resolve();
                });
            });
            const address = created.address();
            const bound =
                typeof address === "object" && address !== null
                    ? address.port
                    : options.port;
            logger.info(
                `Coding sandbox proxy listening on ${options.bind}:${bound} (jobs use ${options.url})`,
            );
            return bound;
        },

        async close(): Promise<void> {
            const current = server;
            server = null;
            if (current === null) {
                return;
            }
            await new Promise<void>((resolve) => {
                current.close(() => resolve());
                current.closeAllConnections();
            });
        },
    };
}
