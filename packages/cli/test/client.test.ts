import type { AddressInfo } from "net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ChatClient, type AuthRejection } from "../src/client";
import { getServerUrl, getSessionFilePath, serverOrigin } from "../src/config";
import { loadSessionIds, sessionIdFor } from "../src/session";

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

    it("sends the auth frame first, then prompts, and records the identity", async () => {
        const frames: unknown[] = [];
        const { url, close } = await withSocketServer((raw, socket) => {
            frames.push(JSON.parse(String(raw)));
            if (frames.length === 1) {
                socket.send(
                    JSON.stringify({
                        authResult: { user: "luke", device: "macbook" },
                    }),
                );
            } else {
                socket.send(JSON.stringify({ chunk: "hi!" }));
                socket.send(JSON.stringify({ done: true }));
            }
        });
        try {
            const client = new ChatClient(url, "tok-1");
            const chunks: string[] = [];
            await client.prompt("hi", "s", { onChunk: (c) => chunks.push(c) });
            expect(frames).toEqual([
                { type: "auth", token: "tok-1" },
                { prompt: "hi", sessionId: "s" },
            ]);
            expect(chunks.join("")).toBe("hi!");
            expect(client.getIdentity()).toEqual({
                user: "luke",
                device: "macbook",
            });
            client.close();
        } finally {
            close();
        }
    });

    it("does not send an auth frame when no token is provided", async () => {
        const frames: unknown[] = [];
        const { url, close } = await withSocketServer((raw, socket) => {
            frames.push(JSON.parse(String(raw)));
            socket.send(JSON.stringify({ done: true }));
        });
        try {
            const client = new ChatClient(url);
            await client.prompt("hi", "s", { onChunk: () => {} });
            expect(frames).toEqual([{ prompt: "hi", sessionId: "s" }]);
            expect(client.getIdentity()).toBeNull();
        } finally {
            close();
        }
    });

    it("falls back to a guest socket and reports an invalid token", async () => {
        const frames: unknown[] = [];
        const rejections: AuthRejection[] = [];
        const { url, close } = await withSocketServer((raw, socket) => {
            frames.push(JSON.parse(String(raw)));
            if (frames.length === 1) {
                socket.send(JSON.stringify({ error: "invalid device token" }));
                socket.send(JSON.stringify({ done: true }));
            } else {
                socket.send(JSON.stringify({ done: true }));
            }
        });
        try {
            const client = new ChatClient(url, "tok-1", (r) =>
                rejections.push(r),
            );
            await client.prompt("one", "s", { onChunk: () => {} });
            await client.prompt("two", "s", { onChunk: () => {} });
            expect(rejections).toEqual(["invalid"]);
            expect(frames).toEqual([
                { type: "auth", token: "tok-1" },
                { prompt: "one", sessionId: "s" },
                { prompt: "two", sessionId: "s" },
            ]);
            expect(client.getIdentity()).toBeNull();
        } finally {
            close();
        }
    });

    it("reports a revoked token mid-prompt and rejects the stream", async () => {
        const rejections: AuthRejection[] = [];
        const frames: unknown[] = [];
        const { url, close } = await withSocketServer((raw, socket) => {
            frames.push(JSON.parse(String(raw)));
            if (frames.length === 1) {
                socket.send(
                    JSON.stringify({
                        authResult: { user: "luke", device: "macbook" },
                    }),
                );
            } else {
                socket.send(JSON.stringify({ chunk: "partial" }));
                socket.send(
                    JSON.stringify({
                        error: "device token revoked; reconnect to re-authenticate",
                    }),
                );
            }
        });
        try {
            const client = new ChatClient(url, "tok-1", (r) =>
                rejections.push(r),
            );
            await expect(
                client.prompt("hi", "s", { onChunk: () => {} }),
            ).rejects.toThrow(/device token revoked/);
            expect(rejections).toEqual(["revoked"]);
        } finally {
            close();
        }
    });

    it("treats a socket dying during the handshake as an invalid token", async () => {
        const rejections: AuthRejection[] = [];
        const { url, close } = await withSocketServer((_raw, socket) => {
            socket.close();
        });
        try {
            const client = new ChatClient(url, "tok-1", (r) =>
                rejections.push(r),
            );
            await expect(
                client.prompt("hi", "s", { onChunk: () => {} }),
            ).rejects.toThrow(/closed during setup/);
            expect(rejections).toEqual(["invalid"]);
        } finally {
            close();
        }
    });

    it("continues as a guest when the server never answers the handshake", async () => {
        const frames: unknown[] = [];
        const rejections: AuthRejection[] = [];
        const { url, close } = await withSocketServer((raw, socket) => {
            frames.push(JSON.parse(String(raw)));
            if (frames.length > 1) {
                socket.send(JSON.stringify({ done: true }));
            }
        });
        try {
            const client = new ChatClient(
                url,
                "tok-1",
                (r) => rejections.push(r),
                50,
            );
            await client.prompt("hi", "s", { onChunk: () => {} });
            expect(rejections).toEqual([]);
            expect(frames).toEqual([
                { type: "auth", token: "tok-1" },
                { prompt: "hi", sessionId: "s" },
            ]);
            expect(client.getIdentity()).toBeNull();
        } finally {
            close();
        }
    });

    it("rejects a stray authResult arriving during a prompt", async () => {
        const { url, close } = await withSocketServer((_raw, socket) => {
            socket.send(
                JSON.stringify({
                    authResult: { user: "luke", device: "macbook" },
                }),
            );
        });
        try {
            const client = new ChatClient(url);
            await expect(
                client.prompt("hi", "s", { onChunk: () => {} }),
            ).rejects.toThrow(/unexpected authResult during a prompt/);
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

describe("serverOrigin", () => {
    it("converts the ws scheme to http and drops the path", () => {
        expect(serverOrigin("ws://localhost:54321/ws")).toBe(
            "http://localhost:54321",
        );
    });

    it("treats URLs that differ only by path as the same origin", () => {
        expect(serverOrigin("ws://localhost:54321")).toBe(
            serverOrigin("ws://localhost:54321/ws"),
        );
    });

    it("converts wss to https", () => {
        expect(serverOrigin("wss://jarvis.example/ws")).toBe(
            "https://jarvis.example",
        );
    });

    it("passes http(s) URLs through", () => {
        expect(serverOrigin("http://localhost:54321/api")).toBe(
            "http://localhost:54321",
        );
        expect(serverOrigin("https://jarvis.example/api")).toBe(
            "https://jarvis.example",
        );
    });

    it("keeps non-default ports", () => {
        expect(serverOrigin("ws://192.168.1.10:8080/ws")).toBe(
            "http://192.168.1.10:8080",
        );
    });

    it("throws on an invalid URL", () => {
        expect(() => serverOrigin("not a url")).toThrow(/invalid server URL/);
    });

    it("throws on an unsupported scheme", () => {
        expect(() => serverOrigin("ftp://jarvis.example/files")).toThrow(
            /unsupported server URL scheme/,
        );
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

        const first = sessionIdFor(loadSessionIds(), { kind: "guest" });
        expect(first.length).toBeGreaterThan(0);
        expect(readFileSync(path, "utf8")).toContain("guest");

        const second = sessionIdFor(loadSessionIds(), { kind: "guest" });
        expect(second).toBe(first);
    });
});
