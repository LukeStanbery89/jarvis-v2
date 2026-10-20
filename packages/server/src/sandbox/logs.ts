/**
 * Coding-job logs (#141 phase 7): the full run, on disk.
 *
 * The container is removed when a job settles, and the row keeps only a
 * bounded tail, so without a file the interesting half of a failure — what the
 * agent actually did before it stopped — exists only while the container does.
 * The supervisor therefore tees every line into a file as it arrives (a crash
 * leaves what was written), and the file outlives the container.
 *
 * The file is capped rather than rotated: a runaway agent should not be able
 * to fill the disk through its own log. Past the cap one marker line says so
 * and writing stops; the row's tail still has the end of the run.
 *
 * Everything here is best-effort. A log is commentary — an unwritable disk
 * must never cost a job its ending, which is why `write` never throws.
 */
import { createWriteStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir } from "@lukestanbery/jarvis-auth";

/** One job's log file, open for the life of its supervision. */
export interface JobLog {
    /** Absolute path of the file, for a boot line or an API response. */
    readonly path: string;
    /** Appends one line (a newline is added); a no-op after the cap or close. */
    write(line: string): void;
    /** Whether the cap was reached (the marker line was written). */
    readonly truncated: boolean;
    /** Flushes and closes the file; idempotent. */
    close(): Promise<void>;
}

/** The deterministic path of a job's log. */
export function codingLogPath(logRoot: string, jobId: string): string {
    return path.join(logRoot, `${jobId}.log`);
}

/**
 * Opens a job's log for writing.
 *
 * Truncates rather than appends: a resumed job replays the container's log from
 * its start, so appending would duplicate the part a dead process had already
 * written. The container's log is the source of truth while it exists.
 *
 * @param options - The root, the job and the byte cap.
 * @returns The open log.
 */
export function createJobLog(options: {
    logRoot: string;
    jobId: string;
    maxBytes: number;
}): JobLog {
    const file = codingLogPath(options.logRoot, options.jobId);
    try {
        ensurePrivateDir(path.dirname(file));
    } catch {
        // A read-only or missing volume loses the log, not the job.
    }
    const stream = createWriteStream(file, {
        flags: "w",
        mode: 0o600,
    });
    // A log that cannot be written is a lost convenience, not a failed job.
    stream.on("error", () => {});
    let written = 0;
    let truncated = false;
    let closed = false;

    return {
        path: file,
        get truncated(): boolean {
            return truncated;
        },
        write(line: string): void {
            if (closed || truncated) {
                return;
            }
            const entry = `${line}\n`;
            const bytes = Buffer.byteLength(entry);
            if (written + bytes > options.maxBytes) {
                truncated = true;
                stream.write(
                    `\n[log truncated at ${options.maxBytes} bytes]\n`,
                );
                return;
            }
            written += bytes;
            stream.write(entry);
        },
        async close(): Promise<void> {
            if (closed) {
                return;
            }
            closed = true;
            await new Promise<void>((resolve) => {
                stream.end(() => resolve());
                stream.once("error", () => resolve());
            });
        },
    };
}

/**
 * Removes log files older than the retention window.
 *
 * Age comes from `mtime`, not the job id: a log for a row that was pruned is
 * exactly the case this must still catch, and a row cannot answer for it.
 *
 * @param options - The root, the window and the clock.
 * @returns How many files were removed and how many bytes that reclaimed.
 */
export async function sweepCodingLogs(options: {
    logRoot: string;
    olderThanMs: number;
    now?: Date;
}): Promise<{ removed: number; bytes: number }> {
    let entries: string[];
    try {
        entries = await readdir(options.logRoot);
    } catch {
        return { removed: 0, bytes: 0 };
    }
    const cutoff = (options.now ?? new Date()).getTime() - options.olderThanMs;
    let removed = 0;
    let bytes = 0;
    for (const entry of entries) {
        if (!entry.endsWith(".log")) {
            continue;
        }
        const file = path.join(options.logRoot, entry);
        try {
            const info = await stat(file);
            if (info.mtimeMs > cutoff) {
                continue;
            }
            bytes += info.size;
            await rm(file, { force: true });
            removed += 1;
        } catch {
            // An unreadable or already-gone file is not a boot failure.
        }
    }
    return { removed, bytes };
}
