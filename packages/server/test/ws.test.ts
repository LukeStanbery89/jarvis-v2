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
        if (prompt === "slow") {
            await new Promise((resolve) => setTimeout(resolve, 300));
            yield { type: "token", text: "slow" };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        yield { type: "token", text: "Hello," };
        yield { type: "token", text: " World!" };
    }),
}));

const store = new SqliteAppStore(new Database(":memory:"));
const appConfig = {
    appDbPath: ":memory:",
    turnTimeoutMs: 30_000,
    bootstrapToken: undefined,
} as const;

const server = createApp(store, appConfig).listen(0);
attachChatServer(server, store);

const timeoutServer = createApp(store, appConfig).listen(0);
attachChatServer(timeoutServer, store, { turnTimeoutMs: 30 });

let url: string;
let timeoutUrl: string;

beforeAll(() => {
    const address = server.address() as AddressInfo | null;
    url = `ws://localhost:${address?.port ?? 0}/ws`;
    const timeoutAddress = timeoutServer.address() as AddressInfo | null;
    timeoutUrl = `ws://localhost:${timeoutAddress?.port ?? 0}/ws`;
});

afterAll(async () => {
    server.close();
    timeoutServer.close();
    // Let pending server-side socket-close handlers (guest-session cleanup)
    // flush before the store is shut down.
    await settle();
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
        const user = store.createUser("luke", "unused", "user");
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
        const user = store.createUser("lateauth", "unused", "user");
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

describe("session ledger", () => {
    it("deletes a guest session when the socket closes", async () => {
        const threadId = "guest-ledger-session";
        const { error } = await exchange({
            prompt: "hi",
            sessionId: threadId,
        });
        expect(error).toBeNull();
        await settle();

        expect(store.getSessionByThread(threadId)).toBeNull();
    });

    it("keeps an owned session alive after the socket closes", async () => {
        const user = store.createUser("ledger-owner", "unused", "user");
        const material = generateDeviceToken();
        store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );
        const threadId = "owned-ledger-session";

        const { frames } = await twoPhase(
            [{ type: "auth", token: material.token }],
            "authResult",
            [{ prompt: "hi", sessionId: threadId }],
        );
        expect(frames.some((f) => f.authResult !== undefined)).toBe(true);
        await settle();

        const session = store.getSessionByThread(threadId);
        expect(session).not.toBeNull();
        expect(session!.userId).toBe(user.id);
    });

    it("rejects a concurrent turn on the same thread across sockets", async () => {
        const first = chat("lock-thread");
        const second = chat("lock-thread");
        const [a, b] = await Promise.all([first, second]);

        expect(a.error ?? b.error).not.toBeNull();
        const errored = [a, b].find((r) => r.error !== null)!;
        const streamed = [a, b].find((r) => r.error === null)!;
        expect(errored.error).toMatch(/in progress/);
        expect(streamed.chunks.join("")).toBe("Hello, World!");
    });

    it("aborts a turn that exceeds the configured timeout", async () => {
        const result = await chatOn(
            { prompt: "slow", sessionId: "timeout-thread" },
            { url: timeoutUrl },
        );
        expect(result.error).toMatch(/timed out/);
        expect(result.chunks).toEqual([]);
    });

    it("rejects a guest from using a session owned by another account", async () => {
        const user = store.createUser("owner-guy", "unused", "user");
        const material = generateDeviceToken();
        store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );
        const threadId = "owner-secret-thread";

        await twoPhase(
            [{ type: "auth", token: material.token }],
            "authResult",
            [{ prompt: "hi", sessionId: threadId }],
        );

        const guest = await exchange({ prompt: "hi", sessionId: threadId });
        expect(guest.error).toMatch(/another user/);
        expect(guest.chunks).toEqual([]);
    });

    it("rejects a token for a session owned by another account", async () => {
        const alice = store.createUser("alice", "unused", "user");
        const bob = store.createUser("bob", "unused", "user");
        const aliceMaterial = generateDeviceToken();
        const bobMaterial = generateDeviceToken();
        store.createDevice(
            alice.id,
            "alice-phone",
            aliceMaterial.tokenHash,
            aliceMaterial.prefix,
        );
        store.createDevice(
            bob.id,
            "bob-phone",
            bobMaterial.tokenHash,
            bobMaterial.prefix,
        );
        const threadId = "alice-thread";

        await twoPhase(
            [{ type: "auth", token: aliceMaterial.token }],
            "authResult",
            [{ prompt: "hi", sessionId: threadId }],
        );

        const { again } = await twoPhase(
            [{ type: "auth", token: bobMaterial.token }],
            "authResult",
            [{ prompt: "hi", sessionId: threadId }],
        );
        expect(
            again.some((f) => f.error === "session belongs to another user"),
        ).toBe(true);
    });

    it("adopts a guest-owned session for the authenticating user", async () => {
        const user = store.createUser("adopter", "unused", "user");
        const material = generateDeviceToken();
        store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );
        const threadId = "guest-then-owned";

        // Guest claims the thread and *stays open* so the row survives to be
        // adopted. Wait for its `done` frame first so the thread lock is free.
        const guestWs = new WebSocket(url);
        await new Promise<void>((resolve) => {
            guestWs.on("open", () => {
                guestWs.send(
                    JSON.stringify({ prompt: "hi", sessionId: threadId }),
                );
            });
            guestWs.on("message", (data) => {
                const msg = JSON.parse(data.toString()) as Record<
                    string,
                    unknown
                >;
                if (msg.done !== undefined) {
                    resolve();
                }
            });
        });
        await settle();

        const adopter = await twoPhase(
            [{ type: "auth", token: material.token }],
            "authResult",
            [{ prompt: "hi", sessionId: threadId }],
        );
        expect(adopter.frames.some((f) => typeof f.error === "string")).toBe(
            false,
        );

        // Closing the (now stale) guest socket must NOT delete the adopted row.
        guestWs.close();
        await settle();

        const session = store.getSessionByThread(threadId);
        expect(session).not.toBeNull();
        expect(session!.userId).toBe(user.id);
    });

    it("lets a second device of the same user continue the thread", async () => {
        const user = store.createUser("two-devices", "unused", "user");
        const first = generateDeviceToken();
        const second = generateDeviceToken();
        store.createDevice(user.id, "mac-a", first.tokenHash, first.prefix);
        store.createDevice(user.id, "mac-b", second.tokenHash, second.prefix);
        const threadId = "shared-thread";

        await twoPhase([{ type: "auth", token: first.token }], "authResult", [
            { prompt: "hi", sessionId: threadId },
        ]);

        const { again } = await twoPhase(
            [{ type: "auth", token: second.token }],
            "authResult",
            [{ prompt: "hi", sessionId: threadId }],
        );
        expect(again.some((f) => typeof f.error === "string")).toBe(false);
        expect(again.some((f) => f.done === true)).toBe(true);
    });

    it("keeps serving after the timeout fires on a dropped socket", async () => {
        await new Promise<void>((resolve) => {
            const ws = new WebSocket(timeoutUrl);
            ws.on("open", () => {
                ws.send(
                    JSON.stringify({ prompt: "slow", sessionId: "drop-me" }),
                );
                // Drop before the 30ms turn timeout fires.
                setTimeout(() => {
                    ws.close();
                    resolve();
                }, 5);
            });
            ws.on("error", () => resolve());
        });

        // Give the timer a beat to fire against the closed socket, then prove
        // the server still accepts + streams a fresh turn.
        await settle();
        const stillAlive = await chatOn(
            { prompt: "hi", sessionId: "alive-check" },
            { url: timeoutUrl },
        );
        expect(stillAlive.error).toBeNull();
        expect(stillAlive.chunks.join("")).toBe("Hello, World!");
    });
});

/** Sends a prompt on a fresh socket at `url`, resolving when the reply ends. */
function chat(
    sessionId: string,
): Promise<{ chunks: string[]; error: string | null }> {
    return chatOn({ prompt: "hi", sessionId });
}

/**
 * Sends one payload on a fresh socket (optionally not `url`), resolving when
 * the reply ends with `done`.
 */
function chatOn(
    payload: unknown,
    opts: { url?: string } = {},
): Promise<{ chunks: string[]; error: string | null }> {
    const target = opts.url ?? url;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(target);
        const chunks: string[] = [];
        let error: string | null = null;
        ws.on("open", () => ws.send(JSON.stringify(payload)));
        ws.on("message", (data) => {
            const msg = JSON.parse(data.toString());
            if (typeof msg.chunk === "string") {
                chunks.push(msg.chunk);
            }
            if (typeof msg.error === "string") {
                error = msg.error;
            }
            if (msg.done === true) {
                ws.close();
                resolve({ chunks, error });
            }
        });
        ws.on("error", reject);
    });
}

/** Waits a beat so the server-side socket-close handler runs. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 40));
}

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
