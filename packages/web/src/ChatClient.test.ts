/**
 * Unit tests for the browser chat wire client, driven by a fake WebSocket
 * (the client's socket constructor is injectable, so the full state machine
 * — handshake, streaming, revocation, reconnect — runs in the node test
 * environment without a browser or network).
 */
import { describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "@lukestanbery/jarvis-protocol";
import { ChatClient, type ChatClientEvents } from "./ChatClient";

/** Minimal WebSocket double: records sends, dispatches driven events. */
class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {}

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.readyState = 3;
        this.onclose?.();
    }

    /** Test driver: completes the TCP+HTTP connect. */
    open(): void {
        this.readyState = FakeSocket.OPEN;
        this.onopen?.();
    }

    /** Test driver: delivers one server frame. */
    receive(frame: unknown): void {
        this.onmessage?.({
            data: typeof frame === "string" ? frame : JSON.stringify(frame),
        });
    }

    /** Test driver: drops the connection. */
    drop(): void {
        this.readyState = 3;
        this.onclose?.();
    }
}

/** Instrumented client + the fakes it created. */
interface Harness {
    sockets: FakeSocket[];
    statuses: string[];
    frames: ServerFrame[];
    readonly authRejected: number;
    client: ChatClient;
}

/** Builds a client with an injected fake-socket factory. */
function makeClient(
    token = "tok",
    events: Partial<ChatClientEvents> = {},
): Harness {
    const sockets: FakeSocket[] = [];
    const statuses: string[] = [];
    const frames: ServerFrame[] = [];
    let authRejected = 0;
    const client = new ChatClient("ws://localhost:54321/ws", {
        token,
        capabilities: ["markdown"],
        events: {
            onStatus: (status) => statuses.push(status),
            onFrame: (frame) => frames.push(frame),
            onAuthRejected: () => {
                authRejected += 1;
            },
            ...events,
        },
        socketFactory: (url) => {
            const socket = new FakeSocket(url);
            sockets.push(socket);
            return socket as unknown as WebSocket;
        },
    });
    return {
        sockets,
        statuses,
        frames,
        get authRejected() {
            return authRejected;
        },
        client,
    };
}

/** Drives a client from connect() through a successful authResult. */
function connected(harness: Harness): FakeSocket {
    harness.client.connect();
    const socket = harness.sockets[0];
    socket.open();
    socket.receive({ authResult: { user: "u", device: "d" } });
    return socket;
}

describe("ChatClient handshake", () => {
    it("sends hello as the very first frame and auth right behind it", () => {
        const harness = makeClient("tok");
        harness.client.connect();
        const socket = harness.sockets[0];
        socket.open();
        expect(JSON.parse(socket.sent[0])).toEqual({
            type: "hello",
            capabilities: ["markdown"],
        });
        expect(JSON.parse(socket.sent[1])).toEqual({
            type: "auth",
            token: "tok",
        });
    });

    it("reports connecting → connected around the authResult verdict", () => {
        const harness = makeClient();
        harness.client.connect();
        expect(harness.statuses).toEqual(["connecting"]);
        harness.sockets[0].open();
        harness.sockets[0].receive({
            authResult: { user: "u", device: "d" },
        });
        expect(harness.statuses).toEqual(["connecting", "connected"]);
    });

    it("reports auth rejection on a handshake error frame and never reconnects", () => {
        const harness = makeClient("bad-token");
        harness.client.connect();
        const socket = harness.sockets[0];
        socket.open();
        socket.receive({ error: "invalid device token" });
        socket.receive({ done: true });
        expect(harness.authRejected).toBe(1);
        expect(harness.statuses).toContain("closed");
        expect(harness.sockets.length).toBe(1);
        socket.receive({ chunk: "stray" });
        expect(harness.frames).toEqual([]);
    });

    it("ignores the trailing done after a handshake error", () => {
        const harness = makeClient("bad-token");
        harness.client.connect();
        const socket = harness.sockets[0];
        socket.open();
        socket.receive({ error: "invalid device token" });
        expect(() => socket.receive({ done: true })).not.toThrow();
        expect(harness.authRejected).toBe(1);
    });

    it("reconnects when the handshake verdict never arrives", async () => {
        vi.useFakeTimers();
        try {
            const harness = makeClient();
            harness.client.connect();
            harness.sockets[0].open();
            await vi.advanceTimersByTimeAsync(5_000);
            expect(harness.sockets.length).toBe(1);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(harness.sockets.length).toBe(2);
            expect(harness.statuses).toContain("reconnecting");
            const second = harness.sockets[1];
            second.open();
            second.receive({ authResult: { user: "u", device: "d" } });
            expect(harness.statuses).toContain("connected");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("ChatClient prompts", () => {
    it("streams a turn and resolves on done", async () => {
        const harness = makeClient();
        const socket = connected(harness);
        const pending = harness.client.prompt("hi", "s1");
        socket.receive({ chunk: "Hel" });
        socket.receive({ chunk: "lo" });
        socket.receive({ done: true });
        await expect(pending).resolves.toBeUndefined();
        expect(harness.frames).toEqual([{ chunk: "Hel" }, { chunk: "lo" }]);
        expect(JSON.parse(socket.sent[2])).toEqual({
            prompt: "hi",
            sessionId: "s1",
            mode: "text",
        });
    });

    it("queues a prompt sent while the handshake is still in flight", async () => {
        const harness = makeClient();
        harness.client.connect();
        const socket = harness.sockets[0];
        const pending = harness.client.prompt("hi", "s1");
        socket.open();
        expect(socket.sent).toHaveLength(2);
        socket.receive({ authResult: { user: "u", device: "d" } });
        await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
        expect(JSON.parse(socket.sent[2])).toEqual({
            prompt: "hi",
            sessionId: "s1",
            mode: "text",
        });
        socket.receive({ done: true });
        await expect(pending).resolves.toBeUndefined();
    });

    it("rejects a second concurrent prompt", async () => {
        const harness = makeClient();
        const socket = connected(harness);
        const first = harness.client.prompt("one", "s1");
        await expect(harness.client.prompt("two", "s2")).rejects.toThrow(
            "another prompt is already in progress",
        );
        socket.receive({ done: true });
        await expect(first).resolves.toBeUndefined();
    });

    it("rejects on an error frame with the server's message and stays usable", async () => {
        const harness = makeClient();
        const socket = connected(harness);
        const pending = harness.client.prompt("boom", "s1");
        socket.receive({ error: "another request is already in progress" });
        socket.receive({ done: true });
        await expect(pending).rejects.toThrow(
            "another request is already in progress",
        );
        const next = harness.client.prompt("again", "s1");
        socket.receive({ done: true });
        await expect(next).resolves.toBeUndefined();
    });

    it("surfaces mid-prompt revocation as an auth rejection without reconnecting", async () => {
        const harness = makeClient();
        const socket = connected(harness);
        const pending = harness.client.prompt("hi", "s1");
        socket.receive({
            error: "device token revoked; reconnect to re-authenticate",
        });
        await expect(pending).rejects.toThrow("authentication failed");
        expect(harness.authRejected).toBe(1);
        expect(harness.sockets.length).toBe(1);
        await expect(harness.client.prompt("hi", "s1")).rejects.toThrow(
            "authentication failed",
        );
    });

    it("rejects the prompt and reconnects after an unexpected drop", async () => {
        vi.useFakeTimers();
        try {
            const harness = makeClient();
            harness.client.connect();
            const first = harness.sockets[0];
            first.open();
            first.receive({ authResult: { user: "u", device: "d" } });
            const pending = harness.client.prompt("hi", "s1");
            first.drop();
            await expect(pending).rejects.toThrow(
                "connection closed while streaming",
            );
            await vi.advanceTimersByTimeAsync(1_000);
            expect(harness.sockets.length).toBe(2);
            expect(harness.statuses).toContain("reconnecting");
            const second = harness.sockets[1];
            second.open();
            second.receive({ authResult: { user: "u", device: "d" } });
            const next = harness.client.prompt("hi", "s1");
            second.receive({ done: true });
            await expect(next).resolves.toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects the prompt on a malformed server frame without reconnecting", async () => {
        const harness = makeClient();
        const socket = connected(harness);
        const pending = harness.client.prompt("hi", "s1");
        socket.onmessage?.({ data: "not json" });
        await expect(pending).rejects.toThrow(
            "received a malformed message from the server",
        );
        expect(harness.sockets.length).toBe(1);
    });

    it("closes for good on close(): no reconnect, prompts fail", async () => {
        vi.useFakeTimers();
        try {
            const harness = makeClient();
            const socket = connected(harness);
            const pending = harness.client.prompt("hi", "s1");
            harness.client.close();
            await expect(pending).rejects.toThrow("chat client is closed");
            await vi.advanceTimersByTimeAsync(60_000);
            expect(harness.sockets.length).toBe(1);
            socket.receive({ chunk: "stray" });
            expect(harness.frames).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});
