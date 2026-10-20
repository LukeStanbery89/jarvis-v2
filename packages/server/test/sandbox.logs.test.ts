/**
 * Coding-job log files and their retention (#141 phase 7).
 *
 * The writer is deliberately exercised through a real file: the properties
 * that matter — a cap that stops a runaway, a truncation marker, and a sweep
 * that ages by `mtime` rather than by a row that may no longer exist — are all
 * filesystem facts, not mock assertions.
 */
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    codingLogPath,
    createJobLog,
    sweepCodingLogs,
} from "../src/sandbox/logs";

const dirs: string[] = [];

/** A temp directory the suite removes afterwards. */
function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("a job's log file", () => {
    it("writes lines privately and closes cleanly", async () => {
        const root = tempDir("jarvis-logs-");
        const log = createJobLog({
            logRoot: root,
            jobId: "job-1",
            maxBytes: 1024,
        });

        log.write('{"type":"step_start"}');
        log.write('{"type":"text","part":{"text":"hi"}}');
        await log.close();
        log.write("after close");

        const file = codingLogPath(root, "job-1");
        expect(readFileSync(file, "utf8")).toBe(
            '{"type":"step_start"}\n{"type":"text","part":{"text":"hi"}}\n',
        );
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(log.truncated).toBe(false);
    });

    it("stops at the cap with one marker instead of growing forever", async () => {
        const root = tempDir("jarvis-logs-");
        const log = createJobLog({
            logRoot: root,
            jobId: "job-cap",
            maxBytes: 40,
        });

        log.write("0123456789"); // 11 bytes with the newline
        log.write("0123456789");
        log.write("0123456789");
        log.write("0123456789");
        expect(log.truncated).toBe(true);
        log.write("never written");
        await log.close();

        const text = readFileSync(codingLogPath(root, "job-cap"), "utf8");
        expect(text).toContain("0123456789");
        expect(text).toContain("[log truncated at 40 bytes]");
        expect(text).not.toContain("never written");
    });
});

describe("log retention", () => {
    it("removes files past the window and keeps the rest", async () => {
        const root = tempDir("jarvis-logs-");
        const old = path.join(root, "old.log");
        const fresh = path.join(root, "fresh.log");
        writeFileSync(old, "old\n");
        writeFileSync(fresh, "fresh\n");
        const longAgo = new Date("2026-08-01T00:00:00.000Z");
        utimesSync(old, longAgo, longAgo);

        const swept = await sweepCodingLogs({
            logRoot: root,
            olderThanMs: 30 * 86_400_000,
            now: new Date("2026-10-19T12:00:00.000Z"),
        });

        expect(swept).toEqual({ removed: 1, bytes: 4 });
        expect(() => statSync(old)).toThrow();
        expect(statSync(fresh).size).toBe(6);
    });

    it("is silent about a root that does not exist", async () => {
        const swept = await sweepCodingLogs({
            logRoot: path.join(tmpdir(), "jarvis-logs-never-created"),
            olderThanMs: 1,
        });
        expect(swept).toEqual({ removed: 0, bytes: 0 });
    });
});
