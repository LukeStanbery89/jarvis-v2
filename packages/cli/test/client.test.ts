import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { ChatClient } from "../src/client";
import { getServerUrl } from "../src/config";

const server = createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
    socket.on("message", () => {
        for (const chunk of ["Hello,", " World!"]) {
            socket.send(JSON.stringify({ chunk }));
        }
        socket.send(JSON.stringify({ done: true }));
    });
});

let url: string;

beforeAll(async () => {
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
    wss.close();
    server.close();
});

describe("ChatClient", () => {
    it("streams chunks from the server until done", async () => {
        const client = new ChatClient(url);
        const chunks: string[] = [];

        await client.prompt("hi", (chunk) => chunks.push(chunk));

        expect(chunks.join("")).toBe("Hello, World!");
        client.close();
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
        delete process.env.JARVIS_SERVER_URL;
    });
});
