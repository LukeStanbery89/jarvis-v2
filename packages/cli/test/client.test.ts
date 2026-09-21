import type { AddressInfo } from "net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ChatClient } from "../src/client";
import { getServerUrl, getSessionFilePath } from "../src/config";
import { loadOrCreateSessionId } from "../src/session";

/**
 * Starts an ephemeral HTTP server with a WebSocket endpoint wired to
 * `onMessage` and returns its base URL, one wss per test so upgrades never
 * collide.
 */
async function withSocketServer(
    onMessage: (raw: unknown, socket: WebSocket) => void,
): Promise<{ url: string; close: () => void }> {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => {
        socket.on("message", (raw) => onMessage(raw, socket));
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    return {
        url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => {
            wss.close();
            server.close();
        },
    };
}

afterEach(() => {
    delete process.env.JARVIS_SERVER_URL;
    delete process.env.JARVIS_SESSION_FILE;
});

describe("ChatClient", () => {
    it("sends the sessionId with the prompt and streams chunks until done", async () => {
        let received: unknown;
        const { url, close } = await withSocketServer((raw, socket) => {
            received = JSON.parse(String(raw));
            for (const chunk of ["Hello,", " World!"]) {
                socket.send(JSON.stringify({ chunk }));
            }
            socket.send(JSON.stringify({ done: true }));
        });
        try {
            const client = new ChatClient(url);
            const chunks: string[] = [];
            await client.prompt("hi", "abc-123", {
                onChunk: (chunk) => chunks.push(chunk),
            });
            expect(chunks.join("")).toBe("Hello, World!");
            expect(received).toEqual({ prompt: "hi", sessionId: "abc-123" });
            client.close();
        } finally {
            close();
        }
    });

    it("invokes the tool callbacks for tool and toolResult frames", async () => {
        const { url, close } = await withSocketServer((_raw, socket) => {
            socket.send(
                JSON.stringify({ tool: { name: "getCurrentTime", args: {} } }),
            );
            socket.send(
                JSON.stringify({
                    toolResult: {
                        name: "getCurrentTime",
                        output: "2026-09-20T00:00:00Z",
                    },
                }),
            );
            socket.send(JSON.stringify({ chunk: "done!" }));
            socket.send(JSON.stringify({ done: true }));
        });
        try {
            const client = new ChatClient(url);
            const tools: [string, unknown][] = [];
            const results: [string, unknown][] = [];
            const chunks: string[] = [];
            await client.prompt("time?", "s", {
                onChunk: (chunk) => chunks.push(chunk),
                onTool: (name, args) => tools.push([name, args]),
                onToolResult: (name, output) => results.push([name, output]),
            });
            expect(chunks.join("")).toBe("done!");
            expect(tools).toEqual([["getCurrentTime", {}]]);
            expect(results).toEqual([
                ["getCurrentTime", "2026-09-20T00:00:00Z"],
            ]);
            client.close();
        } finally {
            close();
        }
    });

    it("rejects when the server closes the socket mid-stream", async () => {
        const { url, close } = await withSocketServer((_raw, socket) => {
            socket.send(JSON.stringify({ chunk: "partial" }));
            socket.close();
        });
        try {
            const client = new ChatClient(url);
            await expect(
                client.prompt("hi", "s", { onChunk: () => {} }),
            ).rejects.toThrow(/closed while streaming/);
        } finally {
            close();
        }
    });

    it("rejects a prompt while another is already streaming", async () => {
        const { url, close } = await withSocketServer((_raw, socket) => {
            socket.send(JSON.stringify({ done: true }));
        });
        try {
            const client = new ChatClient(url);
            const first = client.prompt("one", "s", { onChunk: () => {} });
            await expect(
                client.prompt("two", "s", { onChunk: () => {} }),
            ).rejects.toThrow(/in progress/);
            await first;
        } finally {
            close();
        }
    });

    it("allows prompt after the previous one completed", async () => {
        const { url, close } = await withSocketServer((_raw, socket) => {
            socket.send(JSON.stringify({ done: true }));
        });
        try {
            const client = new ChatClient(url);
            await client.prompt("one", "s", { onChunk: () => {} });
            await client.prompt("two", "s", { onChunk: () => {} });
        } finally {
            close();
        }
    });
});

describe("getServerUrl", () => {
    it("defaults to the local dev server", () => {
        delete process.env.JARVIS_SERVER_URL;
        expect(getServerUrl()).toBe("ws://localhost:54321/ws");
    });

    it("reads JARVIS_SERVER_URL", () => {
        process.env.JARVIS_SERVER_URL = "ws://example.test/ws";
        expect(getServerUrl()).toBe("ws://example.test/ws");
    });
});

describe("sessions", () => {
    describe("getSessionFilePath", () => {
        it("defaults to ~/.jarvis/session-id", () => {
            expect(getSessionFilePath()).toBe(
                `${homedir()}/.jarvis/session-id`,
            );
        });

        it("honours JARVIS_SESSION_FILE", () => {
            process.env.JARVIS_SESSION_FILE = "/tmp/jarvis-session";
            expect(getSessionFilePath()).toBe("/tmp/jarvis-session");
        });
    });

    it("creates a session id file on first use and reuses it after", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-session-"));
        const path = join(dir, "session-id");
        process.env.JARVIS_SESSION_FILE = path;

        const first = loadOrCreateSessionId();
        expect(first.length).toBeGreaterThan(0);
        expect(readFileSync(path, "utf8").trim()).toBe(first);

        const second = loadOrCreateSessionId();
        expect(second).toBe(first);
    });
});
