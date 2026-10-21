/**
 * The live half of a coding job's log (#141 phase 7).
 *
 * The file is the record; this is what makes a running job watchable. The
 * supervisor publishes every line here as it reads it, so a page can replay
 * what it missed and then follow along — and a job that settles mid-stream
 * tells its listeners to stop instead of leaving a request open until the
 * proxy times out.
 *
 * Deliberately in-memory and bounded: a log is useful while the job is
 * interesting, the file survives it, and this must never become a second
 * unbounded copy of every run. The ring holds the last few hundred lines (the
 * same window a late joiner needs) and finished jobs are dropped once the map
 * grows past its cap, oldest first.
 */
import { logger } from "../logger";

/** One subscriber to a live log. */
export interface CodingLogListener {
    /** One complete line, without its terminator. */
    onLine(line: string): void;
    /** The job settled (or is already settled); nothing more will arrive. */
    onEnd(): void;
}

/** A job's replay window plus a way to follow it. */
export interface CodingLogStream {
    /** Lines already published, oldest first. */
    readonly replay: readonly string[];
    /** Follows the job; the returned function unsubscribes. */
    subscribe(listener: CodingLogListener): () => void;
}

/** The hub the supervisor publishes into and the API reads from. */
export interface CodingLogHub {
    /** Appends one line and wakes every listener. */
    publish(jobId: string, line: string): void;
    /** Marks a job's stream finished; listeners get `onEnd` exactly once. */
    finish(jobId: string): void;
    /** Replay and subscription for one job; safe for a settled job too. */
    open(jobId: string): CodingLogStream;
}

/** How many lines a late joiner gets, and how many jobs are remembered. */
const DEFAULT_RING_LINES = 500;
const DEFAULT_MAX_JOBS = 20;

/** One job's in-memory state. */
interface Entry {
    ring: string[];
    listeners: Set<CodingLogListener>;
    done: boolean;
}

/**
 * Builds the hub.
 *
 * @param options - Ring size and remembered-job cap (tests use tiny ones).
 * @returns The hub.
 */
export function createCodingLogHub(
    options: { ringLines?: number; maxJobs?: number } = {},
): CodingLogHub {
    const ringLines = options.ringLines ?? DEFAULT_RING_LINES;
    const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    const entries = new Map<string, Entry>();

    /** Drops the oldest finished job once the map is over its cap. */
    function evict(): void {
        if (entries.size <= maxJobs) {
            return;
        }
        for (const [jobId, entry] of entries) {
            if (entry.done) {
                entries.delete(jobId);
                return;
            }
        }
    }

    /** The job's entry, created on first use. */
    function entryFor(jobId: string): Entry {
        const existing = entries.get(jobId);
        if (existing !== undefined) {
            return existing;
        }
        const created: Entry = {
            ring: [],
            listeners: new Set(),
            done: false,
        };
        entries.set(jobId, created);
        evict();
        return created;
    }

    return {
        publish(jobId: string, line: string): void {
            const entry = entryFor(jobId);
            if (entry.done) {
                return;
            }
            entry.ring.push(line);
            if (entry.ring.length > ringLines) {
                entry.ring.shift();
            }
            for (const listener of entry.listeners) {
                try {
                    listener.onLine(line);
                } catch (err) {
                    logger.warn(
                        `coding log hub: a listener threw: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                }
            }
        },

        finish(jobId: string): void {
            const entry = entries.get(jobId);
            if (entry === undefined || entry.done) {
                return;
            }
            entry.done = true;
            for (const listener of entry.listeners) {
                try {
                    listener.onEnd();
                } catch {
                    // The listener's socket is already gone.
                }
            }
            entry.listeners.clear();
        },

        open(jobId: string): CodingLogStream {
            const entry = entryFor(jobId);
            return {
                replay: [...entry.ring],
                subscribe(listener: CodingLogListener): () => void {
                    if (entry.done) {
                        // A late joiner still gets the replay; the end signal
                        // lets the caller close instead of waiting forever.
                        queueMicrotask(() => {
                            try {
                                listener.onEnd();
                            } catch {
                                // Ignore a socket that closed in between.
                            }
                        });
                        return () => {};
                    }
                    entry.listeners.add(listener);
                    return () => {
                        entry.listeners.delete(listener);
                    };
                },
            };
        },
    };
}
