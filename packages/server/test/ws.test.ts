import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app";
import { attachChatServer } from "../src/ws";

vi.mock("../src/agent", () => ({
    runAgent: vi.fn(async function* (prompt: string) {
        if (prompt === "boom") {
            throw new Error("model exploded");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        yield "Hello,";
        yield " World!";
    }),
}));

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

    it("replies with an error frame when the model request fails", async () => {
        const { chunks, done, error } = await exchange({ prompt: "boom" });
        expect(error).toMatch(/model request failed/);
        expect(done).toBe(true);
        expect(chunks).toEqual([]);
    });

    it("rejects a new prompt while the previous response is streaming", async () => {
        const result = await exchangeMany(
            [{ prompt: "first" }, { prompt: "second" }],
            2,
        );
        expect(result.chunks.join("")).toBe("Hello, World!");
        expect(result.errors.join(";")).toMatch(/in progress/);
        expect(result.dones).toBe(2);
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
