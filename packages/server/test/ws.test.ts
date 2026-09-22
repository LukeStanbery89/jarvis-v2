import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import Database from "better-sqlite3";
import { createApp } from "../src/app";
import { attachChatServer } from "../src/ws";
import { SqliteAppStore, generateDeviceToken } from "../src/auth";
import type { AgentEvent } from "../src/llm/agentGraph";

vi.mock("../src/agent", () => ({
    runAgent: vi.fn(async function* (
        prompt: string,
        _sessionId: string,
    ): AsyncGenerator<AgentEvent> {
        if (prompt === "boom") {
            throw new Error("model exploded");
        }
        if (prompt === "tools") {
            yield { type: "tool", name: "getCurrentTime", args: {} };
            yield {
                type: "toolResult",
                name: "getCurrentTime",
                output: "2026-09-20T00:00:00.000Z",
            };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        yield { type: "token", text: "Hello," };
        yield { type: "token", text: " World!" };
    }),
}));

const store = new SqliteAppStore(new Database(":memory:"));
const server = createApp().listen(0);
attachChatServer(server, store);

let url: string;

beforeAll(() => {
    const address = server.address() as AddressInfo | null;
    url = `ws://localhost:${address?.port ?? 0}/ws`;
});

afterAll(() => {
    server.close();
    store.close();
});

const SESSION_ID = "test-session";

describe("chat websocket", () => {
    it("streams the response as chunks and finishes with done", async () => {
        const { chunks, tools, done, error } = await exchange({
            prompt: "hi",
            sessionId: SESSION_ID,
        });
        expect(error).toBeNull();
        expect(done).toBe(true);
        expect(chunks.join("")).toBe("Hello, World!");
        expect(tools).toHaveLength(0);
    });

    it("forwards tool and toolResult events from the agent", async () => {
        const { chunks, tools, toolResults, done, error } = await exchange({
            prompt: "tools",
            sessionId: SESSION_ID,
        });
        expect(error).toBeNull();
        expect(done).toBe(true);
        expect(chunks.join("")).toBe("Hello, World!");
        expect(tools).toEqual([{ name: "getCurrentTime", args: {} }]);
        expect(toolResults).toEqual([
            { name: "getCurrentTime", output: "2026-09-20T00:00:00.000Z" },
        ]);
    });

    it("replies with an error frame for an invalid message", async () => {
        const { chunks, done, error } = await exchange({ nope: true });
        expect(error).toMatch(/prompt/i);
        expect(done).toBe(true);
        expect(chunks).toEqual([]);
    });

    it("replies with an error frame when sessionId is missing", async () => {
        const { chunks, done, error } = await exchange({ prompt: "hi" });
        expect(error).toMatch(/sessionId/i);
        expect(done).toBe(true);
        expect(chunks).toEqual([]);
    });

    it("replies with an error frame when the model request fails", async () => {
        const { chunks, done, error } = await exchange({
            prompt: "boom",
            sessionId: SESSION_ID,
        });
        expect(error).toMatch(/model request failed/);
        expect(done).toBe(true);
        expect(chunks).toEqual([]);
    });

    it("rejects a new prompt while the previous response is streaming", async () => {
        const result = await exchangeMany(
            [
                { prompt: "first", sessionId: SESSION_ID },
                { prompt: "second", sessionId: SESSION_ID },
            ],
            2,
        );
        expect(result.chunks.join("")).toBe("Hello, World!");
        expect(result.errors.join(";")).toMatch(/in progress/);
        expect(result.dones).toBe(2);
    });
});

describe("auth handshake", () => {
    it("authenticates a valid device token on the first frame", async () => {
        const user = store.createUser("luke", "unused", "owner");
        const material = generateDeviceToken();
        store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );

        const { frames } = await collectFrames(
            [{ type: "auth", token: material.token }],
            { until: "authResult" },
        );
        expect(frames).toContainEqual({
            authResult: { user: "luke", device: "macbook" },
        });
        expect(frames.some((f) => typeof f.error === "string")).toBe(false);
    });

    it("rejects an unknown device token with an error frame", async () => {
        const { frames } = await collectFrames(
            [{ type: "auth", token: "not-a-real-token" }],
            { until: "done" },
        );
        expect(frames).toContainEqual({ error: "invalid device token" });
        expect(frames.some((f) => f.authResult !== undefined)).toBe(false);
    });

    it("rejects an auth frame once the handshake slot is consumed", async () => {
        const user = store.createUser("lateauth", "unused", "owner");
        const material = generateDeviceToken();
        store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );

        const { frames, again } = await twoPhase(
            [{ type: "auth", token: material.token }],
            "authResult",
            [{ type: "auth", token: material.token }],
        );
        expect(frames).toContainEqual({
            authResult: { user: "lateauth", device: "macbook" },
        });
        expect(again).toContainEqual({
            error: "auth handshake must be the first frame",
        });
    });

    it("still chats as a guest when the first frame is a prompt", async () => {
        const { frames } = await collectFrames(
            [{ prompt: "hi", sessionId: SESSION_ID }],
            { until: "done" },
        );
        expect(frames[frames.length - 1]).toEqual({ done: true });
        expect(frames.some((f) => f.authResult !== undefined)).toBe(false);
    });
});

function exchange(payload: unknown): Promise<{
    chunks: string[];
    tools: { name: string; args?: unknown }[];
    toolResults: { name: string; output?: unknown }[];
    done: boolean;
    error: string | null;
}> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const chunks: string[] = [];
        const tools: { name: string; args?: unknown }[] = [];
        const toolResults: { name: string; output?: unknown }[] = [];
        let done = false;
        let error: string | null = null;

        ws.on("open", () => ws.send(JSON.stringify(payload)));
        ws.on("message", (data) => {
            const msg = JSON.parse(data.toString());
            if (typeof msg.chunk === "string") {
                chunks.push(msg.chunk);
            }
            if (msg.tool) {
                tools.push({ name: msg.tool.name, args: msg.tool.args });
            }
            if (msg.toolResult) {
                toolResults.push({
                    name: msg.toolResult.name,
                    output: msg.toolResult.output,
                });
            }
            if (typeof msg.error === "string") {
                error = msg.error;
            }
            if (msg.done === true) {
                done = true;
                ws.close();
                resolve({ chunks, tools, toolResults, done, error });
            }
        });
        ws.on("error", reject);
    });
}

/** Sends every payload in order on one socket, resolving after `expectedDones`. */
function exchangeMany(
    payloads: unknown[],
    expectedDones: number,
): Promise<{
    chunks: string[];
    errors: string[];
    dones: number;
}> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const chunks: string[] = [];
        const errors: string[] = [];
        let dones = 0;

        ws.on("open", () => {
            for (const payload of payloads) {
                ws.send(JSON.stringify(payload));
            }
        });
        ws.on("message", (data) => {
            const msg = JSON.parse(data.toString());
            if (typeof msg.chunk === "string") {
                chunks.push(msg.chunk);
            }
            if (typeof msg.error === "string") {
                errors.push(msg.error);
            }
            if (msg.done === true) {
                dones += 1;
                if (dones === expectedDones) {
                    ws.close();
                    resolve({ chunks, errors, dones });
                }
            }
        });
        ws.on("error", reject);
    });
}

/**
 * Sends every payload in order on one socket, collecting raw frames until
 * `count` frames of the chosen stop-key (default `done`) arrive.
 */
function collectFrames(
    payloads: unknown[],
    opts: { until?: "done" | "authResult"; count?: number } = {},
): Promise<{ frames: Record<string, unknown>[] }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const frames: Record<string, unknown>[] = [];
        const key = opts.until ?? "done";
        const stopAfter = opts.count ?? 1;
        let stops = 0;

        ws.on("open", () => {
            for (const payload of payloads) {
                ws.send(JSON.stringify(payload));
            }
        });
        ws.on("message", (data) => {
            const msg = JSON.parse(data.toString()) as Record<string, unknown>;
            frames.push(msg);
            if (msg[key] !== undefined) {
                stops += 1;
                if (stops >= stopAfter) {
                    ws.close();
                    resolve({ frames });
                }
            }
        });
        ws.on("error", reject);
    });
}

/**
 * Two-phase helper: sends `first`, waits for a `firstKey` frame, then sends
 * `second` and collects until `done`. Returns both phases.
 */
function twoPhase(
    first: unknown[],
    firstKey: "done" | "authResult",
    second: unknown[],
): Promise<{
    frames: Record<string, unknown>[];
    again: Record<string, unknown>[];
}> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const frames: Record<string, unknown>[] = [];
        const again: Record<string, unknown>[] = [];
        let phase: 1 | 2 = 1;
        ws.on("open", () => {
            for (const p of first) {
                ws.send(JSON.stringify(p));
            }
        });
        ws.on("message", (data) => {
            const msg = JSON.parse(data.toString()) as Record<string, unknown>;
            if (phase === 1) {
                frames.push(msg);
                if (msg[firstKey] !== undefined) {
                    phase = 2;
                    for (const p of second) {
                        ws.send(JSON.stringify(p));
                    }
                }
            } else {
                again.push(msg);
                if (msg.done !== undefined) {
                    ws.close();
                    resolve({ frames, again });
                }
            }
        });
        ws.on("error", reject);
    });
}
