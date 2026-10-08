/**
 * Unit tests for the browser chat wire client, driven by a fake WebSocket
 * (the client's socket constructor is injectable, so the full state machine
 * — handshake, streaming, revocation, reconnect — runs in the node test
 * environment without a browser or network).
 */
import { describe, expect, it, vi } from "vitest";
import { pcmToS16le, type ServerFrame } from "@lukestanbery/jarvis-protocol";
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

    it("sends attachment ids on the wire frame when provided", async () => {
        const harness = makeClient();
        const socket = connected(harness);
        const pending = harness.client.prompt("look", "s1", ["att-1", "att-2"]);
        socket.receive({ done: true });
        await expect(pending).resolves.toBeUndefined();
        expect(JSON.parse(socket.sent[2])).toEqual({
            prompt: "look",
            sessionId: "s1",
            mode: "text",
            attachments: ["att-1", "att-2"],
        });
    });

    it("omits the attachments key entirely for a plain prompt", async () => {
        const harness = makeClient();
        const socket = connected(harness);
        const pending = harness.client.prompt("hi", "s1", []);
        socket.receive({ done: true });
        await expect(pending).resolves.toBeUndefined();
        expect(JSON.parse(socket.sent[2])).toEqual({
            prompt: "hi",
            sessionId: "s1",
            mode: "text",
        });
        expect("attachments" in JSON.parse(socket.sent[2])).toBe(false);
    });

    it("sends voice mode when the turn originates from the microphone", async () => {
        const harness = makeClient();
        const socket = connected(harness);
        const pending = harness.client.prompt(
            "what time is it",
            "s1",
            [],
            "voice",
        );
        socket.receive({ done: true });
        await expect(pending).resolves.toBeUndefined();
        expect(JSON.parse(socket.sent[2])).toEqual({
            prompt: "what time is it",
            sessionId: "s1",
            mode: "voice",
        });
    });

    it("decodes binary messages into audio chunks without disturbing the turn (#83)", async () => {
        const audioChunks: Float32Array[] = [];
        const harness = makeClient("tok", {
            onAudio: (pcm) => {
                audioChunks.push(pcm);
            },
        });
        const socket = connected(harness);
        const pending = harness.client.prompt("hi", "s1");
        // One binary audio chunk mid-turn: s16le samples for [0.5, -0.5].
        const binary = pcmToS16le(new Float32Array([0.5, -0.5]));
        socket.onmessage?.({
            data: binary.buffer.slice(
                binary.byteOffset,
                binary.byteOffset + binary.byteLength,
            ),
        });
        socket.receive({ done: true });
        await expect(pending).resolves.toBeUndefined();
        expect(audioChunks).toHaveLength(1);
        expect(audioChunks[0]![0]).toBeCloseTo(0.5, 3);
        expect(audioChunks[0]![1]).toBeCloseTo(-0.5, 3);
        expect(harness.frames).toEqual([]); // binary never parsed as a frame
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

describe("ChatClient.sendLocation (#31)", () => {
    it("sends a location frame on a ready socket", () => {
        const harness = makeClient();
        const socket = connected(harness);
        harness.client.sendLocation(45.523198, -122.676512);
        const last = JSON.parse(socket.sent[socket.sent.length - 1]!);
        expect(last).toEqual({
            type: "location",
            lat: 45.523198,
            lon: -122.676512,
        });
    });

    it("stores the report and re-sends it after a reconnect handshake", async () => {
        vi.useFakeTimers();
        try {
            const harness = makeClient();
            connected(harness);
            harness.client.sendLocation(45.5, -122.6);
            harness.sockets[0]!.drop();
            await vi.advanceTimersByTimeAsync(1_000);
            const reconnected = harness.sockets[1]!;
            reconnected.open();
            reconnected.receive({ authResult: { user: "u", device: "d" } });
            const frames = reconnected.sent.map((raw) => JSON.parse(raw));
            expect(frames[0]).toEqual({
                type: "hello",
                capabilities: ["markdown"],
            });
            expect(frames[1]).toEqual({ type: "auth", token: "tok" });
            expect(frames[2]).toEqual({
                type: "location",
                lat: 45.5,
                lon: -122.6,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it("sends a report immediately even mid-handshake, without duplicating it", () => {
        const harness = makeClient();
        harness.client.connect();
        const socket = harness.sockets[0]!;
        socket.open();
        // The server accepts location frames at any point in the socket's
        // lifetime, so a report during the handshake goes straight out.
        harness.client.sendLocation(45.5, -122.6);
        let frames = socket.sent.map((raw) => JSON.parse(raw));
        expect(frames).toHaveLength(3);
        expect(frames[2]).toEqual({ type: "location", lat: 45.5, lon: -122.6 });
        // The authResult-triggered re-send must NOT duplicate it.
        socket.receive({ authResult: { user: "u", device: "d" } });
        frames = socket.sent.map((raw) => JSON.parse(raw));
        expect(frames).toHaveLength(3);
    });
});

describe("turn cancellation (#84 P6)", () => {
    /** Delivers one binary audio chunk the way the browser would. */
    function deliverBinary(socket: FakeSocket, samples: number[]): void {
        const binary = pcmToS16le(new Float32Array(samples));
        socket.onmessage?.({
            data: binary.buffer.slice(
                binary.byteOffset,
                binary.byteOffset + binary.byteLength,
            ),
        });
    }

    it("sends the cancel frame and drops the cancelled generation's audio", async () => {
        const audioChunks: Float32Array[] = [];
        const harness = makeClient("tok", {
            onAudio: (pcm) => audioChunks.push(pcm),
        });
        const socket = connected(harness);
        const pending = harness.client.prompt("hi", "s1");
        socket.receive({
            audioStart: {
                generationId: 3,
                format: "pcm_s16le",
                sampleRate: 24000,
                channels: 1,
            },
        });
        deliverBinary(socket, [0.5, -0.5]);
        expect(audioChunks).toHaveLength(1);

        harness.client.cancelTurn();
        expect(socket.sent).toContain('{"type":"cancel"}');
        // A chunk of the cancelled generation still in flight never plays.
        deliverBinary(socket, [0.25, -0.25]);
        expect(audioChunks).toHaveLength(1);
        socket.receive({ done: true });
        await expect(pending).resolves.toBeUndefined();
    });

    it("stops audio that arrives after the cancel even with no chunk played yet", async () => {
        const audioChunks: Float32Array[] = [];
        const harness = makeClient("tok", {
            onAudio: (pcm) => audioChunks.push(pcm),
        });
        const socket = connected(harness);
        const pending = harness.client.prompt("hi", "s1");
        socket.receive({
            audioStart: {
                generationId: 1,
                format: "pcm_s16le",
                sampleRate: 24000,
                channels: 1,
            },
        });
        harness.client.cancelTurn();
        deliverBinary(socket, [0.5, -0.5]);
        expect(audioChunks).toHaveLength(0);
        socket.receive({ done: true });
        await expect(pending).resolves.toBeUndefined();
    });

    it("a fresh turn's audio plays after a cancelled one", async () => {
        const audioChunks: Float32Array[] = [];
        const harness = makeClient("tok", {
            onAudio: (pcm) => audioChunks.push(pcm),
        });
        const socket = connected(harness);
        const cancelled = harness.client.prompt("hi", "s1");
        socket.receive({
            audioStart: {
                generationId: 1,
                format: "pcm_s16le",
                sampleRate: 24000,
                channels: 1,
            },
        });
        harness.client.cancelTurn();
        socket.receive({ done: true });
        await expect(cancelled).resolves.toBeUndefined();

        const next = harness.client.prompt("and now?", "s1");
        socket.receive({
            audioStart: {
                generationId: 2,
                format: "pcm_s16le",
                sampleRate: 24000,
                channels: 1,
            },
        });
        deliverBinary(socket, [0.5, -0.5]);
        expect(audioChunks).toHaveLength(1);
        socket.receive({ done: true });
        await expect(next).resolves.toBeUndefined();
    });

    it("cancelTurn with no turn in flight sends nothing", () => {
        const harness = makeClient("tok");
        connected(harness);
        harness.client.cancelTurn();
        const socket = harness.sockets[0]!;
        // Only the handshake frames on the wire.
        expect(socket.sent).toHaveLength(2);
    });
});
