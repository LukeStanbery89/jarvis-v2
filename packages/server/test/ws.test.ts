import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app";
import { attachChatServer } from "../src/ws";
import { responseTokens } from "../src/stream";

const server = createApp().listen(0);
attachChatServer(server);

let url: string;

beforeAll(() => {
    const address = server.address() as AddressInfo | null;
    url = `ws://localhost:${address?.port ?? 0}/ws`;
});

afterAll(() => {
    server.close();
});

describe("responseTokens", () => {
    it("returns the streaming tokens for a prompt", () => {
        expect(responseTokens("hi")).toEqual(["Hello,", " World!"]);
    });
});

describe("chat websocket", () => {
    it("streams the response as chunks and finishes with done", async () => {
        const { chunks, done, error } = await exchange({ prompt: "hi" });
        expect(error).toBeNull();
        expect(done).toBe(true);
        expect(chunks.join("")).toBe("Hello, World!");
    });

    it("replies with an error frame for an invalid message", async () => {
        const { chunks, done, error } = await exchange({ nope: true });
        expect(error).toMatch(/prompt/i);
        expect(done).toBe(true);
        expect(chunks).toEqual([]);
    });
});

function exchange(payload: unknown): Promise<{
    chunks: string[];
    done: boolean;
    error: string | null;
}> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const chunks: string[] = [];
        let done = false;
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
                done = true;
                ws.close();
                resolve({ chunks, done, error });
            }
        });
        ws.on("error", reject);
    });
}
