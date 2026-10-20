/**
 * The coding-job log endpoint (#141 phase 7).
 *
 * One job's output, as newline-delimited JSON: the same frames the container
 * printed, so a page can render them or a person can read them with `curl`.
 * While the job runs the response **replays** what the in-memory hub still
 * holds and then follows the container until it settles; once it has settled
 * the response is the log file, which is the part that outlives the container.
 *
 * Owner-scoped through the row, not through a role: `getCodingJob(user, id)`
 * answers `null` for somebody else's id, so a foreign job is indistinguishable
 * from a missing one (404), the same posture as the scheduler's REST surface.
 *
 * NDJSON rather than SSE on purpose: every line is already one JSON frame, the
 * browser can read the body of a normal authenticated `fetch` (an `EventSource`
 * cannot send a device token), and a settled job's file can be served byte for
 * byte. Streaming responses are exempt from the runtime contract validation
 * (see `contractValidation.ts`); the spec still documents the shape.
 */
import { createReadStream } from "node:fs";
import { Router, type Request, type Response } from "express";
import type { AppConfig } from "../config";
import {
    createCookieSessionProvider,
    type AppDatabase,
} from "@lukestanbery/jarvis-auth";
import { sessionCookieName } from "../http/cookies";
import { authed, requireAuth } from "../http/middleware";
import { logger } from "../logger";
import type { CodingLogStream } from "./logHub";
import { codingLogPath } from "./logs";

/** The live-log capability the router needs; the service satisfies it. */
export interface CodingLogSource {
    openLogStream(jobId: string): CodingLogStream;
}

/** Whether a job still has output to stream from the hub. */
function isLive(state: string): boolean {
    return state === "queued" || state === "running";
}

/**
 * Seeds the response headers for a newline-delimited stream.
 *
 * `x-accel-buffering: no` is for the reverse proxy some deployments put in
 * front of the app: without it nginx holds the first chunk until the buffer
 * fills, which makes a live tail look dead.
 */
function startStream(res: Response): void {
    res.status(200);
    res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();
}

/**
 * Builds the router.
 *
 * @param store - The app database (row lookup and auth).
 * @param logs - The supervisor's live-log capability.
 * @param appConfig - The deployment's sandbox log root and cookie settings.
 * @returns The router, mounted at `/api`.
 */
export function createCodingLogRouter(
    store: AppDatabase,
    logs: CodingLogSource,
    appConfig: AppConfig,
): Router {
    const router = Router();
    const secure = Boolean(appConfig.tlsCertPath && appConfig.tlsKeyPath);
    const authenticated = requireAuth(store, {
        provider: createCookieSessionProvider(store, {
            ttlMs: appConfig.sessionTtlMs,
        }),
        cookieName: sessionCookieName(secure),
    });
    const logRoot = appConfig.sandbox?.logRoot ?? "";

    router.get(
        "/coding-jobs/:id/logs",
        authenticated,
        (req: Request, res: Response) => {
            const jarv = authed(req).jarv;
            const raw = req.params.id;
            const id = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
            const job = store.getCodingJob(jarv.user.id, id);
            if (job === null) {
                res.status(404).json({ error: "coding job not found" });
                return;
            }

            startStream(res);

            if (!isLive(job.state)) {
                // Settled: the file is the record, and it is complete where the
                // hub is only a window. A job that never started a container
                // has no file — an empty 200 is the honest answer.
                const file = createReadStream(codingLogPath(logRoot, job.id));
                file.on("error", () => {
                    res.end();
                });
                file.pipe(res);
                return;
            }

            const stream = logs.openLogStream(job.id);
            for (const line of stream.replay) {
                res.write(`${line}\n`);
            }
            let closed = false;
            const unsubscribe = stream.subscribe({
                onLine(line: string): void {
                    if (!closed) {
                        res.write(`${line}\n`);
                    }
                },
                onEnd(): void {
                    if (!closed) {
                        closed = true;
                        res.end();
                    }
                },
            });
            res.on("close", () => {
                closed = true;
                unsubscribe();
            });
            // A stream nobody reads would otherwise hold the response open
            // until the job settles; the timer also catches a proxy that
            // dropped the connection without a `close` event.
            res.on("error", (err: unknown) => {
                closed = true;
                unsubscribe();
                logger.debug(
                    `coding log stream ${job.id}: ${err instanceof Error ? err.message : String(err)}`,
                );
            });
        },
    );

    return router;
}
