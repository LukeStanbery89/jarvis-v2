import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";
import { createApp } from "../src/app";
import { attachChatServer } from "../src/ws";
import { runAgent } from "../src/agent";
import { generateDeviceToken } from "@lukestanbery/jarvis-auth";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AgentEvent } from "../src/llm/agentGraph";

vi.mock("../src/agent", () => ({
    runAgent: vi.fn(async function* (
        prompt: string,
        _sessionId: string,
        options?: { signal?: AbortSignal },
    ): AsyncGenerator<AgentEvent> {
        if (prompt === "boom") {
            throw new Error("model exploded");
        }
        // A slow, cancellable stream (#84 P6): one punctuated token every
        // 40 ms, checking the signal between awaits the way a real model
        // rejects its in-flight fetch on abort.
        if (prompt === "stall") {
            for (const word of [
                "one. ",
                "two. ",
                "three. ",
                "four. ",
                "five. ",
                "six. ",
            ]) {
                await new Promise((resolve) => setTimeout(resolve, 40));
                if (options?.signal?.aborted) {
                    throw new Error("aborted");
                }
                yield { type: "token", text: word };
            }
            return;
        }
        if (prompt === "tools") {
            yield { type: "tool", name: "getCurrentTime", args: {} };
            yield {
                type: "toolResult",
                name: "getCurrentTime",
                output: "2026-09-20T00:00:00.000Z",
            };
        }
        // A turn that calls a tool and then answers nothing: the shape a
        // reasoning model produces when it spends its whole output budget
        // thinking (#31 manual testing).
        if (prompt === "silent") {
            yield { type: "tool", name: "getCurrentTime", args: {} };
            yield {
                type: "toolResult",
                name: "getCurrentTime",
                output: "2026-09-20T00:00:00.000Z",
            };
            return;
        }
        // Whitespace-only prose: the leading newline a reasoning model streams
        // before its tool call, with no answer after the result.
        if (prompt === "blank") {
            yield { type: "token", text: "\n\n" };
            return;
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

const store = createInMemoryAppDatabase();
const appConfig = {
    appDbPath: ":memory:",
    turnTimeoutMs: 30_000,
    bootstrapToken: undefined,
} as const;

const server = createApp(store, appConfig).listen(0);
attachChatServer(server, store);

const timeoutServer = createApp(store, appConfig).listen(0);
attachChatServer(timeoutServer, store, { turnTimeoutMs: 30 });

// The TTS-enabled variant (#83): a fake engine that answers every
// synthesis with two float samples, so the wire slice — segmenter, speaker,
// frames, binary chunks — runs without any model.
const fakeTts: import("../src/tts/types").TtsProvider = {
    id: "fake",
    synthesize: async () => ({
        pcm: new Float32Array([0.25, -0.25]),
        sampleRate: 24000,
    }),
};
const ttsServer = createApp(store, appConfig).listen(0);
attachChatServer(ttsServer, store, { turnTimeoutMs: 30_000, tts: fakeTts });

// The hardening fixture: the wss reference is kept so tests can reach the
// server-side sockets (error emissions, pong listeners, buffer bounds).
const hardeningServer = createApp(store, appConfig).listen(0);
const hardeningWss = attachChatServer(hardeningServer, store);

// A deliberately slow TTS engine: each segment takes 150 ms, so the audio
// drain (after the text stream ends) spans hundreds of milliseconds — wide
// enough to land a `cancel` inside it deterministically.
const slowTts: import("../src/tts/types").TtsProvider = {
    id: "slow-fake",
    synthesize: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { pcm: new Float32Array([0.25, -0.25]), sampleRate: 24000 };
    },
};
const slowTtsServer = createApp(store, appConfig).listen(0);
attachChatServer(slowTtsServer, store, { turnTimeoutMs: 30_000, tts: slowTts });

// A short-heartbeat variant, so the keepalive is testable in real time
// (30 ms instead of the 30 s production default).
const heartbeatServer = createApp(store, appConfig).listen(0);
const heartbeatWss = attachChatServer(heartbeatServer, store, {
    turnTimeoutMs: 30_000,
    heartbeatIntervalMs: 30,
});

let url: string;
let timeoutUrl: string;
let ttsUrl: string;
let hardeningUrl: string;
let slowTtsUrl: string;
let heartbeatUrl: string;

beforeAll(() => {
    const address = server.address() as AddressInfo | null;
    url = `ws://localhost:${address?.port ?? 0}/ws`;
    const timeoutAddress = timeoutServer.address() as AddressInfo | null;
    timeoutUrl = `ws://localhost:${timeoutAddress?.port ?? 0}/ws`;
    const ttsAddress = ttsServer.address() as AddressInfo | null;
    ttsUrl = `ws://localhost:${ttsAddress?.port ?? 0}/ws`;
    const hardeningAddress = hardeningServer.address() as AddressInfo | null;
    hardeningUrl = `ws://localhost:${hardeningAddress?.port ?? 0}/ws`;
    const slowTtsAddress = slowTtsServer.address() as AddressInfo | null;
    slowTtsUrl = `ws://localhost:${slowTtsAddress?.port ?? 0}/ws`;
    const heartbeatAddress = heartbeatServer.address() as AddressInfo | null;
    heartbeatUrl = `ws://localhost:${heartbeatAddress?.port ?? 0}/ws`;
});

afterAll(async () => {
    server.close();
    timeoutServer.close();
    ttsServer.close();
    hardeningServer.close();
    slowTtsServer.close();
    heartbeatServer.close();
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

    it("reports an empty response when the model answers nothing after a tool call", async () => {
        const { chunks, toolResults, done, error } = await exchange({
            prompt: "silent",
            sessionId: SESSION_ID,
        });
        expect(error).toMatch(/empty response/i);
        expect(done).toBe(true);
        expect(chunks).toEqual([]);
        expect(toolResults).toHaveLength(1);
    });

    it("treats a whitespace-only response as empty", async () => {
        const { chunks, done, error } = await exchange({
            prompt: "blank",
            sessionId: SESSION_ID,
        });
        expect(chunks).toEqual(["\n\n"]);
        expect(error).toMatch(/empty response/i);
        expect(done).toBe(true);
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

describe("hello capability handshake", () => {
    it("accepts a hello as the first frame and forwards capabilities to the agent", async () => {
        const { frames } = await collectFrames(
            [
                { type: "hello", capabilities: ["markdown", "image"] },
                { prompt: "hi", sessionId: "hello-cap-thread" },
            ],
            { until: "done" },
        );
        expect(frames.some((f) => f.error !== undefined)).toBe(false);
        expect(frames[frames.length - 1]).toEqual({ done: true });
        const call = vi
            .mocked(runAgent)
            .mock.calls.find((c) => c[1] === "hello-cap-thread");
        expect(call?.[2]).toEqual({
            capabilities: ["markdown", "image"],
            mode: "text",
            attachmentIds: [],
            signal: expect.any(AbortSignal),
        });
    });

    it("answers a voice-mode prompt with empty capabilities and claims the thread as voice", async () => {
        const { frames } = await collectFrames(
            [
                { type: "hello", capabilities: ["markdown", "image"] },
                { prompt: "hi", sessionId: "voice-thread", mode: "voice" },
            ],
            { until: "done" },
        );
        expect(frames.some((f) => f.error !== undefined)).toBe(false);
        expect(frames[frames.length - 1]).toEqual({ done: true });
        const call = vi
            .mocked(runAgent)
            .mock.calls.find((c) => c[1] === "voice-thread");
        expect(call?.[2]).toEqual({
            capabilities: [],
            mode: "voice",
            attachmentIds: [],
            signal: expect.any(AbortSignal),
        });
        expect(store.getSessionByThread("voice-thread")?.kind).toBe("voice");
    });

    it("keeps declared capabilities for explicit text-mode prompts", async () => {
        const { frames } = await collectFrames(
            [
                { type: "hello", capabilities: ["markdown", "image"] },
                {
                    prompt: "hi",
                    sessionId: "text-explicit-thread",
                    mode: "text",
                },
            ],
            { until: "done" },
        );
        expect(frames.some((f) => f.error !== undefined)).toBe(false);
        const call = vi
            .mocked(runAgent)
            .mock.calls.find((c) => c[1] === "text-explicit-thread");
        expect(call?.[2]).toEqual({
            capabilities: ["markdown", "image"],
            mode: "text",
            attachmentIds: [],
            signal: expect.any(AbortSignal),
        });
        expect(store.getSessionByThread("text-explicit-thread")?.kind).toBe(
            "text",
        );
    });

    it("claims mode-less prompts as text threads", async () => {
        await collectFrames(
            [{ prompt: "hi", sessionId: "text-default-thread" }],
            { until: "done" },
        );
        expect(store.getSessionByThread("text-default-thread")?.kind).toBe(
            "text",
        );
    });

    it("accepts hello then auth, then prompts as an owned socket", async () => {
        const user = store.createUser("hello-auth", "unused", "user");
        const material = generateDeviceToken();
        store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );

        const { again } = await twoPhase(
            [
                { type: "hello", capabilities: ["markdown"] },
                { type: "auth", token: material.token },
            ],
            "authResult",
            [{ prompt: "hi", sessionId: "hello-auth-thread" }],
        );
        expect(again.some((f) => f.authResult !== undefined)).toBe(false);
        expect(again[again.length - 1]).toEqual({ done: true });

        // The prompt really ran as the authenticated principal: a different
        // socket (no handshake of its own) is refused the same thread.
        const { frames: stranger } = await collectFrames(
            [{ prompt: "hi", sessionId: "hello-auth-thread" }],
            { until: "done" },
        );
        expect(stranger).toContainEqual({
            error: "session belongs to another user",
        });
    });

    it("rejects an auth frame after a prompt on a hello-opened socket", async () => {
        const user = store.createUser("late-hello-auth", "unused", "user");
        const material = generateDeviceToken();
        store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );

        const { frames } = await collectFrames(
            [
                { type: "hello", capabilities: ["markdown"] },
                { prompt: "hi", sessionId: "hello-prompt-auth-thread" },
                { type: "auth", token: material.token },
            ],
            { until: "done", count: 2 },
        );
        // The prompt's turn ends with done, then the late auth is refused —
        // a socket can never change identity mid-life.
        expect(frames).toContainEqual({
            error: "auth handshake must be the first frame",
        });
        expect(frames.some((f) => f.authResult !== undefined)).toBe(false);
        const call = vi
            .mocked(runAgent)
            .mock.calls.find((c) => c[1] === "hello-prompt-auth-thread");
        expect(call?.[2]).toEqual({
            capabilities: ["markdown"],
            mode: "text",
            attachmentIds: [],
            signal: expect.any(AbortSignal),
        });
    });

    it("rejects a hello after a prompt", async () => {
        const { frames } = await collectFrames(
            [
                { prompt: "hi", sessionId: "prompt-hello-thread" },
                { type: "hello", capabilities: ["markdown"] },
            ],
            { until: "done", count: 2 },
        );
        expect(frames).toContainEqual({
            error: "hello frame must be the first frame",
        });
    });

    it("keeps a hello-opened socket a guest after a bad token, capabilities intact", async () => {
        const { frames } = await collectFrames(
            [
                { type: "hello", capabilities: ["markdown", "image"] },
                { type: "auth", token: "not-a-real-token" },
                { prompt: "hi", sessionId: "hello-badauth-thread" },
            ],
            { until: "done", count: 2 },
        );
        expect(frames).toContainEqual({ error: "invalid device token" });
        expect(frames.some((f) => f.authResult !== undefined)).toBe(false);
        const call = vi
            .mocked(runAgent)
            .mock.calls.find((c) => c[1] === "hello-badauth-thread");
        expect(call?.[2]).toEqual({
            capabilities: ["markdown", "image"],
            mode: "text",
            attachmentIds: [],
            signal: expect.any(AbortSignal),
        });
    });

    it("accepts a hello with an empty capabilities list (plain text)", async () => {
        const { frames } = await collectFrames(
            [
                { type: "hello", capabilities: [] },
                { prompt: "hi", sessionId: "hello-empty-thread" },
            ],
            { until: "done" },
        );
        expect(frames.some((f) => f.error !== undefined)).toBe(false);
        const call = vi
            .mocked(runAgent)
            .mock.calls.find((c) => c[1] === "hello-empty-thread");
        expect(call?.[2]).toEqual({
            capabilities: [],
            mode: "text",
            attachmentIds: [],
            signal: expect.any(AbortSignal),
        });
    });

    it("rejects a second hello frame", async () => {
        const { frames } = await collectFrames(
            [
                { type: "hello", capabilities: ["markdown"] },
                { type: "hello", capabilities: ["image"] },
            ],
            { until: "done" },
        );
        expect(frames).toContainEqual({
            error: "hello frame must be the first frame",
        });
    });

    it("rejects a hello after the auth handshake consumed the slot", async () => {
        const user = store.createUser("late-hello", "unused", "user");
        const material = generateDeviceToken();
        store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );

        const { again } = await twoPhase(
            [{ type: "auth", token: material.token }],
            "authResult",
            [{ type: "hello", capabilities: ["markdown"] }],
        );
        expect(again).toContainEqual({
            error: "hello frame must be the first frame",
        });
    });

    it("runs plain-text guests without capability conditioning", async () => {
        await collectFrames(
            [{ prompt: "hi", sessionId: "plain-guest-thread" }],
            {
                until: "done",
            },
        );
        const call = vi
            .mocked(runAgent)
            .mock.calls.find((c) => c[1] === "plain-guest-thread");
        expect(call?.[2]).toEqual({
            capabilities: [],
            mode: "text",
            attachmentIds: [],
            signal: expect.any(AbortSignal),
        });
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

    it("rejects an authenticated user from taking a guest-owned session", async () => {
        const user = store.createUser("not-owner-guy", "unused", "user");
        const material = generateDeviceToken();
        store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );
        const threadId = "guest-conversation";

        // A guest claims the thread and stays open while the authed user tries.
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

        const { again } = await twoPhase(
            [{ type: "auth", token: material.token }],
            "authResult",
            [{ prompt: "hi", sessionId: threadId }],
        );
        expect(
            again.some((f) => f.error === "session belongs to another user"),
        ).toBe(true);

        // The caller did NOT seize the thread: it stays guest-owned until the
        // guest disconnects, then guest cleanup removes it entirely.
        const untouched = store.getSessionByThread(threadId);
        expect(untouched).not.toBeNull();
        expect(untouched!.userId).toBeNull();

        guestWs.close();
        await settle();
        expect(store.getSessionByThread(threadId)).toBeNull();
    });

    it("cuts off a socket whose device token was revoked mid-session", async () => {
        const user = store.createUser("revokee", "unused", "user");
        const material = generateDeviceToken();
        const device = store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );
        const threadId = "revoked-device-thread";

        await new Promise<void>((resolve) => {
            const ws = new WebSocket(url);
            let authed = false;
            let revoked = false;
            ws.on("open", () => {
                ws.send(
                    JSON.stringify({ type: "auth", token: material.token }),
                );
            });
            ws.on("message", (data) => {
                const msg = JSON.parse(data.toString()) as Record<
                    string,
                    unknown
                >;
                if (!authed && typeof msg.authResult === "object") {
                    authed = true;
                    store.revokeDevice(device.id);
                    ws.send(
                        JSON.stringify({ prompt: "hi", sessionId: threadId }),
                    );
                    return;
                }
                if (
                    authed &&
                    typeof msg.error === "string" &&
                    /device token revoked/.test(msg.error)
                ) {
                    revoked = true;
                    return;
                }
                if (authed && revoked && msg.done === true) {
                    ws.close();
                    resolve();
                }
            });
            ws.on("error", () => resolve());
        });
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

        // Payloads are sent back-to-back; the server serializes frames itself,
        // so a pipelined handshake chain (e.g. hello → auth) still lands in order.
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

/** Sent hello + prompt, collecting JSON frames and binary byte-counts. */
function speakExchange(
    hello: unknown,
    prompt: unknown,
): Promise<{
    frames: Record<string, unknown>[];
    binaries: number[];
}> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(ttsUrl);
        const frames: Record<string, unknown>[] = [];
        const binaries: number[] = [];
        ws.on("open", () => {
            ws.send(JSON.stringify(hello));
            ws.send(JSON.stringify(prompt));
        });
        ws.on("message", (data, isBinary) => {
            if (isBinary) {
                binaries.push((data as Buffer).length);
                return;
            }
            const msg = JSON.parse(data.toString()) as Record<string, unknown>;
            frames.push(msg);
            if (msg.done === true) {
                ws.close();
                resolve({ frames, binaries });
            }
        });
        ws.on("error", reject);
    });
}

describe("voice audio frames (#83)", () => {
    it("speaks a voice-mode turn for an audio-capable socket", async () => {
        const { frames, binaries } = await speakExchange(
            { type: "hello", capabilities: ["markdown", "audio"] },
            { prompt: "hi", sessionId: SESSION_ID, mode: "voice" },
        );
        const kinds = frames.map((f) => Object.keys(f)[0]);
        const startIndex = kinds.indexOf("audioStart");
        const endIndex = kinds.indexOf("audioEnd");
        const doneIndex = kinds.indexOf("done");
        // Audio frames exist, in order: audioStart … audioEnd … done.
        expect(startIndex).toBeGreaterThan(-1);
        expect(endIndex).toBeGreaterThan(startIndex);
        expect(doneIndex).toBeGreaterThan(endIndex);
        // done is the last frame of the turn.
        expect(doneIndex).toBe(kinds.length - 1);
        const start = frames[startIndex]!.audioStart as Record<string, unknown>;
        expect(start).toEqual({
            generationId: 1,
            format: "pcm_s16le",
            sampleRate: 24000,
            channels: 1,
        });
        expect(frames[endIndex]!.audioEnd as Record<string, unknown>).toEqual({
            generationId: 1,
        });
        // One binary message per synthesized segment: 2 samples × 2 bytes.
        expect(binaries).toEqual([4]);
        // The text stream ran unchanged alongside the audio.
        const chunks = frames.filter((f) => typeof f.chunk === "string");
        expect(chunks.map((f) => f.chunk).join("")).toBe("Hello, World!");
        // audioStart goes out no earlier than the last text chunk — audio
        // trails text within the turn.
        const lastChunkIndex = kinds.lastIndexOf("chunk");
        expect(startIndex).toBeGreaterThan(lastChunkIndex);
    });

    it("sends no audio for a text-mode prompt", async () => {
        const { frames, binaries } = await speakExchange(
            { type: "hello", capabilities: ["markdown", "audio"] },
            { prompt: "hi", sessionId: SESSION_ID },
        );
        expect(frames.some((f) => f.audioStart !== undefined)).toBe(false);
        expect(frames.some((f) => f.audioEnd !== undefined)).toBe(false);
        expect(binaries).toEqual([]);
        expect(frames.some((f) => f.done === true)).toBe(true);
    });

    it("sends no audio to a socket that did not declare the audio capability", async () => {
        const { frames, binaries } = await speakExchange(
            { type: "hello", capabilities: ["markdown"] },
            { prompt: "hi", sessionId: SESSION_ID, mode: "voice" },
        );
        expect(frames.some((f) => f.audioStart !== undefined)).toBe(false);
        expect(binaries).toEqual([]);
        expect(frames.some((f) => f.done === true)).toBe(true);
    });
});

/** One collected socket message: a JSON frame or a binary byte count. */
type CancelItem =
    | { kind: "frame"; frame: Record<string, unknown> }
    | { kind: "binary"; bytes: number };

/**
 * Opens a socket on `target` and returns a manual driver: frames and binary
 * messages arrive in order and are consumed one at a time via {@link next},
 * so tests can act mid-stream (send a `cancel` on the first chunk, race a
 * quiet window, and so on) — shapes `exchange`'s resolve-on-done helper
 * cannot express.
 */
function connect(target: string): Promise<{
    send: (payload: unknown) => void;
    next: () => Promise<CancelItem>;
    close: () => void;
}> {
    const ws = new WebSocket(target);
    const buffered: CancelItem[] = [];
    const waiting: ((item: CancelItem) => void)[] = [];
    const opened = new Promise<void>((resolve) => ws.once("open", resolve));
    ws.on("message", (data, isBinary) => {
        const item: CancelItem = isBinary
            ? { kind: "binary", bytes: (data as Buffer).length }
            : {
                  kind: "frame",
                  frame: JSON.parse((data as Buffer).toString()) as Record<
                      string,
                      unknown
                  >,
              };
        const waiter = waiting.shift();
        if (waiter) {
            waiter(item);
        } else {
            buffered.push(item);
        }
    });
    return opened.then(() => ({
        send: (payload: unknown) => ws.send(JSON.stringify(payload)),
        next: () => {
            const item = buffered.shift();
            if (item !== undefined) {
                return Promise.resolve(item);
            }
            return new Promise((resolve) => waiting.push(resolve));
        },
        close: () => ws.close(),
    }));
}

describe("turn cancellation (#84 P6)", () => {
    it("aborts a streaming text turn: partial text, done without error, lock released", async () => {
        const c = await connect(url);
        c.send({ prompt: "stall", sessionId: SESSION_ID });
        // Cancel the moment the first chunk lands — mid-stream.
        let chunks = "";
        for (;;) {
            const item = await c.next();
            if (item.kind === "frame" && typeof item.frame.chunk === "string") {
                chunks += item.frame.chunk;
                c.send({ type: "cancel" });
                break;
            }
        }
        let done = false;
        let error: string | null = null;
        for (;;) {
            const item = await c.next();
            if (item.kind !== "frame") {
                continue;
            }
            if (typeof item.frame.chunk === "string") {
                chunks += item.frame.chunk;
            }
            if (typeof item.frame.error === "string") {
                error = item.frame.error;
            }
            if (item.frame.done === true) {
                done = true;
                break;
            }
        }
        // Text already streamed stands in history; the turn ends with `done`
        // and never an error frame.
        expect(done).toBe(true);
        expect(error).toBeNull();
        expect(chunks).toBe("one. ");
        // The thread lock released: the follow-up turn on the same thread
        // runs to completion instead of being answered `busy`.
        c.send({ prompt: "hi", sessionId: SESSION_ID });
        let followUp = "";
        for (;;) {
            const item = await c.next();
            if (item.kind !== "frame") {
                continue;
            }
            if (typeof item.frame.chunk === "string") {
                followUp += item.frame.chunk;
            }
            if (item.frame.done === true) {
                break;
            }
        }
        expect(followUp).toBe("Hello, World!");
        c.close();
    });

    it("honors a cancel queued before the stream starts", async () => {
        const c = await connect(url);
        // Pipelined: the prompt joins the tail, the cancel bypasses it and
        // marks the turn for abort-at-start.
        c.send({ prompt: "stall", sessionId: `${SESSION_ID}-queued` });
        c.send({ type: "cancel" });
        let chunks = "";
        let error: string | null = null;
        for (;;) {
            const item = await c.next();
            if (item.kind !== "frame") {
                continue;
            }
            if (typeof item.frame.chunk === "string") {
                chunks += item.frame.chunk;
            }
            if (typeof item.frame.error === "string") {
                error = item.frame.error;
            }
            if (item.frame.done === true) {
                break;
            }
        }
        expect(chunks).toBe("");
        expect(error).toBeNull();
        c.close();
    });

    it("ignores a cancel with no turn in flight", async () => {
        const c = await connect(url);
        c.send({ type: "cancel" });
        // A stray cancel must be silent. Assert it by what follows: the
        // next turn's response arrives byte-perfect — a spurious `done`
        // would truncate it to "" and a spurious `error` would surface
        // below (a dangling quiet-window race would also strand the
        // driver's waiter, so the absence is checked through the payload).
        await new Promise((resolve) => setTimeout(resolve, 80));
        c.send({ prompt: "hi", sessionId: `${SESSION_ID}-idle-cancel` });
        let chunks = "";
        let error: string | null = null;
        for (;;) {
            const item = await c.next();
            if (item.kind !== "frame") {
                continue;
            }
            if (typeof item.frame.chunk === "string") {
                chunks += item.frame.chunk;
            }
            if (typeof item.frame.error === "string") {
                error = item.frame.error;
            }
            if (item.frame.done === true) {
                break;
            }
        }
        expect(chunks).toBe("Hello, World!");
        expect(error).toBeNull();
        c.close();
    });

    it("drops spoken audio mid-turn: no audioEnd after cancel, done terminal", async () => {
        const c = await connect(ttsUrl);
        c.send({ type: "hello", capabilities: ["markdown", "audio"] });
        c.send({ prompt: "stall", sessionId: SESSION_ID, mode: "voice" });
        const frames: Record<string, unknown>[] = [];
        const binaries: number[] = [];
        // Collect up to the first binary chunk — audioStart + one PCM
        // segment are on the wire by then — then cancel between chunks.
        for (;;) {
            const item = await c.next();
            if (item.kind === "binary") {
                binaries.push(item.bytes);
                break;
            }
            frames.push(item.frame);
        }
        c.send({ type: "cancel" });
        for (;;) {
            const item = await c.next();
            if (item.kind === "binary") {
                binaries.push(item.bytes);
                continue;
            }
            if (typeof item.frame.error === "string") {
                // An error frame on a deliberate cancel is the bug.
                throw new Error(`unexpected error frame: ${item.frame.error}`);
            }
            frames.push(item.frame);
            if (item.frame.done === true) {
                break;
            }
        }
        // At least the triggering segment got through.
        expect(binaries.length).toBeGreaterThanOrEqual(1);
        // The audio span never closed: `finish()` never ran after the abort.
        expect(frames.some((f) => f.audioStart !== undefined)).toBe(true);
        expect(frames.some((f) => f.audioEnd !== undefined)).toBe(false);
        // done is terminal — the last frame of the turn.
        expect(frames[frames.length - 1]!.done).toBe(true);
        c.close();
    });

    it("runs A→B→C rapid cancels: cancelled turns end, the last turn completes", async () => {
        const c = await connect(url);
        const partials: string[] = [];
        for (const suffix of ["-a", "-b"]) {
            c.send({ prompt: "stall", sessionId: `${SESSION_ID}${suffix}` });
            // First chunk lands → cancel; the turn then ends with `done`.
            let chunks = "";
            for (;;) {
                const item = await c.next();
                if (
                    item.kind === "frame" &&
                    typeof item.frame.chunk === "string"
                ) {
                    chunks += item.frame.chunk;
                    c.send({ type: "cancel" });
                    break;
                }
            }
            partials.push(chunks);
            for (;;) {
                const item = await c.next();
                if (item.kind !== "frame") {
                    continue;
                }
                if (item.frame.done === true) {
                    break;
                }
            }
        }
        // A and B each kept their first sentence, then ended.
        expect(partials).toEqual(["one. ", "one. "]);
        // C — sent without a cancel — runs to completion.
        c.send({ prompt: "hi", sessionId: `${SESSION_ID}-c` });
        let finalChunks = "";
        for (;;) {
            const item = await c.next();
            if (item.kind !== "frame") {
                continue;
            }
            if (typeof item.frame.chunk === "string") {
                finalChunks += item.frame.chunk;
            }
            if (item.frame.done === true) {
                break;
            }
        }
        expect(finalChunks).toBe("Hello, World!");
        c.close();
    });
});

/**
 * Server hardening (#102): error listeners, keepalive heartbeat, send
 * backpressure, and the cancel-vs-audio-drain race. These tests reach the
 * server-side sockets through the kept `wss` references.
 */
describe("server hardening", () => {
    /** Server-side OPEN socket for the only client of `wss`. */
    function onlyClient(wss: WebSocketServer): WebSocket {
        const sockets = [...wss.clients];
        expect(sockets.length).toBe(1);
        return sockets[0]!;
    }

    it("survives socket and server error emissions", async () => {
        const c = await connect(hardeningUrl);
        // Synthesized transport failures: with no listener these would be
        // uncaught exceptions killing the process (the ws library re-emits
        // receiver/sender errors as `'error'`).
        onlyClient(hardeningWss).emit("error", new Error("boom"));
        hardeningWss.emit("error", new Error("server-level boom"));
        // The connection still works end to end.
        c.send({ prompt: "hi", sessionId: "hardening-errors" });
        let chunks = "";
        for (;;) {
            const item = await c.next();
            if (item.kind !== "frame") {
                continue;
            }
            if (typeof item.frame.chunk === "string") {
                chunks += item.frame.chunk;
            }
            if (item.frame.done === true) {
                break;
            }
        }
        expect(chunks).toBe("Hello, World!");
        c.close();
    });

    it("terminates a socket that stops answering pings; a ponging socket survives", async () => {
        // The 30 ms-heartbeat fixture keeps this test in real time.
        const silent = new WebSocket(heartbeatUrl);
        await new Promise((resolve) => silent.once("open", resolve));
        const serverSocket = onlyClient(heartbeatWss);
        // The ws client auto-pongs; removing the server-side listener
        // simulates a vanished peer (sleep, NAT drop) whose pongs never
        // arrive: after one unanswered interval the socket is terminated.
        serverSocket.removeAllListeners("pong");
        const silentClosed = new Promise<boolean>((resolve) =>
            silent.once("close", () => resolve(true)),
        );
        const winner = await Promise.race([
            silentClosed.then(() => "closed" as const),
            new Promise((resolve) =>
                setTimeout(() => resolve("open" as const), 300),
            ),
        ]);
        expect(winner).toBe("closed");

        // A healthy peer answers and is left alone.
        const healthy = new WebSocket(heartbeatUrl);
        await new Promise((resolve) => healthy.once("open", resolve));
        const healthyClosed = new Promise<boolean>((resolve) =>
            healthy.once("close", () => resolve(true)),
        );
        const survived = await Promise.race([
            healthyClosed.then(() => "closed" as const),
            new Promise((resolve) =>
                setTimeout(() => resolve("open" as const), 300),
            ),
        ]);
        // Several full intervals pass; the automatic pongs keep it alive.
        expect(survived).toBe("open");
        healthy.close();
    });

    it("drops chunk frames past the send bound but still ends the turn", async () => {
        const c = await connect(hardeningUrl);
        const serverSocket = onlyClient(hardeningWss);
        // Shadow the prototype getter with a perpetually-full buffer.
        Object.defineProperty(serverSocket, "bufferedAmount", {
            value: 2_000_000,
            configurable: true,
        });
        c.send({ prompt: "hi", sessionId: "hardening-backpressure" });
        const chunks: string[] = [];
        let error: string | null = null;
        let done = false;
        for (;;) {
            const item = await c.next();
            if (item.kind !== "frame") {
                continue;
            }
            if (typeof item.frame.chunk === "string") {
                chunks.push(item.frame.chunk);
            }
            if (typeof item.frame.error === "string") {
                error = item.frame.error;
            }
            if (item.frame.done === true) {
                done = true;
                break;
            }
        }
        // Stream data dropped; the terminal frame always sent.
        expect(chunks).toEqual([]);
        expect(done).toBe(true);
        expect(error).toBeNull();
        delete (serverSocket as unknown as { bufferedAmount?: number })
            .bufferedAmount;
        c.close();
    });

    it("drops the spoken tail when a cancel lands during the audio drain", async () => {
        const c = await connect(slowTtsUrl);
        c.send({ type: "hello", capabilities: ["markdown", "audio"] });
        c.send({
            prompt: "stall",
            sessionId: "hardening-drain-cancel",
            mode: "voice",
        });
        // Consume the whole text stream. The 150 ms/segment synth means the
        // drain outlives the text by hundreds of milliseconds — the cancel
        // below lands inside it. Binaries are counted from the start: the
        // first segment's PCM is delivered while the text is still
        // streaming.
        const binaries: number[] = [];
        let seen = 0;
        for (;;) {
            const item = await c.next();
            if (item.kind === "binary") {
                binaries.push(item.bytes);
                continue;
            }
            if (typeof item.frame.chunk === "string") {
                seen += 1;
            }
            if (seen === 6) {
                break;
            }
        }
        c.send({ type: "cancel" });
        const frames: Record<string, unknown>[] = [];
        for (;;) {
            const item = await c.next();
            if (item.kind === "binary") {
                binaries.push(item.bytes);
                continue;
            }
            frames.push(item.frame);
            if (item.frame.done === true) {
                break;
            }
        }
        // The audio span never closes: the drain was abandoned mid-flight,
        // so the tail segments are never delivered and `audioEnd` never
        // goes out.
        expect(binaries.length).toBeGreaterThanOrEqual(1);
        expect(frames.some((f) => f.audioEnd !== undefined)).toBe(false);
        expect(frames.some((f) => f.error !== undefined)).toBe(false);
        // `done` is terminal.
        expect(frames[frames.length - 1]!.done).toBe(true);
        // The thread lock released: a follow-up turn completes.
        c.send({ prompt: "hi", sessionId: "hardening-drain-cancel" });
        let followUp = "";
        for (;;) {
            const item = await c.next();
            if (item.kind !== "frame") {
                continue;
            }
            if (typeof item.frame.chunk === "string") {
                followUp += item.frame.chunk;
            }
            if (item.frame.done === true) {
                break;
            }
        }
        expect(followUp).toBe("Hello, World!");
        c.close();
    });
});
