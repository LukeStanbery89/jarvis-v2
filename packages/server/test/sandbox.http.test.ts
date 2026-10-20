/**
 * The coding-job log endpoint (#141 phase 7).
 *
 * A real HTTP listener rather than supertest's buffering: the point of the
 * route is that bytes arrive **before** the job ends, so the test follows the
 * stream the way a page does — read what is buffered, publish more, read
 * again, then finish and see the response close.
 */
import express from "express";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    generateDeviceToken,
    type AppDatabase,
} from "@lukestanbery/jarvis-auth";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import {
    DEFAULT_SANDBOX_CONFIG,
    getAppConfig,
    type AppConfig,
    type SandboxConfig,
} from "../src/config";
import { createCodingLogRouter } from "../src/sandbox/http";
import { createCodingLogHub } from "../src/sandbox/logHub";

/** Everything one test has to shut down. */
interface Fixture {
    store: AppDatabase;
    token: string;
    userId: number;
    hub: ReturnType<typeof createCodingLogHub>;
    logRoot: string;
    url(id: string): string;
    close(): Promise<void>;
}

/** A running log endpoint over a real socket. */
async function makeFixture(): Promise<Fixture> {
    const store = createInMemoryAppDatabase();
    const userId = store.createUser("luke", "hash", "owner").id;
    const material = generateDeviceToken();
    store.createDevice(userId, "web-test", material.tokenHash, material.prefix);

    const logRoot = mkdtempSync(path.join(tmpdir(), "jarvis-coding-http-"));
    const sandbox: SandboxConfig = {
        ...DEFAULT_SANDBOX_CONFIG,
        workspaceRoot: path.join(logRoot, "jobs"),
        workspaceHostRoot: path.join(logRoot, "jobs"),
        repos: [],
        logRoot,
    };
    const appConfig: AppConfig = { ...getAppConfig(), sandbox };

    const hub = createCodingLogHub();
    const app = express();
    app.use(express.json());
    app.use(
        "/api",
        createCodingLogRouter(
            store,
            { openLogStream: (jobId) => hub.open(jobId) },
            appConfig,
        ),
    );
    const server: Server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const port =
        typeof address === "object" && address !== null ? address.port : 0;

    return {
        store,
        token: material.token,
        userId,
        hub,
        logRoot,
        url: (id) => `http://127.0.0.1:${port}/api/coding-jobs/${id}/logs`,
        close: async () => {
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
            rmSync(logRoot, { recursive: true, force: true });
        },
    };
}

/** A fixture, closed even when the test throws. */
const fixtures: Fixture[] = [];

afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
        await fixture.close().catch(() => {});
    }
});

/** Seeds one job in the requested state. */
function seedJob(
    fixture: Fixture,
    id: string,
    state: "queued" | "running" | "ok",
    userId = fixture.userId,
): void {
    fixture.store.createCodingJob(userId, {
        id,
        repo: "luke/app",
        branch: "jarvis/test",
        prompt: "do it",
        workspacePath: path.join(fixture.logRoot, "jobs", id, "repo"),
        crashPolicy: "prune",
        model: "lmstudio/qwen3",
        createdAt: "2026-10-19T12:00:00.000Z",
    });
    if (state === "queued") {
        return;
    }
    fixture.store.claimCodingJob(
        id,
        `container-${id}`,
        "2026-10-19T12:00:01.000Z",
    );
    if (state === "ok") {
        fixture.store.settleCodingJob(id, "ok", {}, "2026-10-19T12:00:02.000Z");
    }
}

/** Reads until the accumulated text contains `needle`, or the stream ends. */
async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    text: string,
    needle: string,
): Promise<string> {
    const decoder = new TextDecoder();
    let accumulated = text;
    while (!accumulated.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) {
            return accumulated;
        }
        accumulated += decoder.decode(value, { stream: true });
    }
    return accumulated;
}

describe("coding job log endpoint", () => {
    it("requires a device token", async () => {
        const fixture = await makeFixture();
        fixtures.push(fixture);
        seedJob(fixture, "job-1", "running");

        const response = await fetch(fixture.url("job-1"));

        expect(response.status).toBe(401);
    });

    it("answers 404 for a missing or foreign job", async () => {
        const fixture = await makeFixture();
        fixtures.push(fixture);
        const other = fixture.store.createUser("other", "hash", "owner").id;
        seedJob(fixture, "foreign", "running", other);

        const headers = { authorization: `Bearer ${fixture.token}` };
        expect((await fetch(fixture.url("missing"), { headers })).status).toBe(
            404,
        );
        expect((await fetch(fixture.url("foreign"), { headers })).status).toBe(
            404,
        );
    });

    it("replays and then follows a running job, ending when it settles", async () => {
        const fixture = await makeFixture();
        fixtures.push(fixture);
        seedJob(fixture, "job-live", "running");
        fixture.hub.publish("job-live", '{"type":"step_start"}');

        const response = await fetch(fixture.url("job-live"), {
            headers: { authorization: `Bearer ${fixture.token}` },
            signal: AbortSignal.timeout(5_000),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(
            "application/x-ndjson",
        );
        const reader = response.body?.getReader();
        if (reader === undefined) {
            throw new Error("no response body");
        }

        let text = await readUntil(reader, "", "step_start");
        expect(text).toContain('{"type":"step_start"}\n');

        fixture.hub.publish("job-live", '{"type":"text","part":{"text":"hi"}}');
        text = await readUntil(reader, text, '"hi"');
        expect(text).toContain('{"type":"text","part":{"text":"hi"}}\n');

        fixture.hub.finish("job-live");
        // The end closes the response; a timeout here would mean it never did.
        for (;;) {
            const { done } = await reader.read();
            if (done) {
                break;
            }
        }
    });

    it("serves the file once the job has settled", async () => {
        const fixture = await makeFixture();
        fixtures.push(fixture);
        seedJob(fixture, "job-done", "ok");
        writeFileSync(
            path.join(fixture.logRoot, "job-done.log"),
            '{"one":1}\n{"two":2}\n',
        );

        const response = await fetch(fixture.url("job-done"), {
            headers: { authorization: `Bearer ${fixture.token}` },
        });

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('{"one":1}\n{"two":2}\n');
    });

    it("answers an empty stream when a settled job has no log", async () => {
        const fixture = await makeFixture();
        fixtures.push(fixture);
        seedJob(fixture, "job-empty", "ok");

        const response = await fetch(fixture.url("job-empty"), {
            headers: { authorization: `Bearer ${fixture.token}` },
        });

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("");
    });
});
