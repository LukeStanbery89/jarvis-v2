import { describe, expect, it } from "vitest";
import {
    MAX_CAPABILITIES,
    MAX_CAPABILITY_LENGTH,
    MAX_SESSION_ID_LENGTH,
    MAX_TOKEN_LENGTH,
    parseClientMessage,
    parseFrame,
    parseRequest,
    serializeAuth,
    serializeFrame,
    serializeHello,
    serializeRequest,
} from "../src/index";
import type { ClientCapability, ServerFrame } from "../src/index";

describe("parseFrame", () => {
    it("parses a chunk frame", () => {
        expect(parseFrame('{"chunk":"Hello, World!"}')).toEqual({
            chunk: "Hello, World!",
        });
    });

    it("parses a tool frame with args", () => {
        expect(
            parseFrame('{"tool":{"name":"getCurrentTime","args":{}}}'),
        ).toEqual({ tool: { name: "getCurrentTime", args: {} } });
    });

    it("parses a tool frame without args", () => {
        expect(parseFrame('{"tool":{"name":"calculate"}}')).toEqual({
            tool: { name: "calculate" },
        });
    });

    it("parses a toolResult frame with output", () => {
        expect(
            parseFrame('{"toolResult":{"name":"search","output":"results"}}'),
        ).toEqual({ toolResult: { name: "search", output: "results" } });
    });

    it("parses a done frame", () => {
        expect(parseFrame('{"done":true}')).toEqual({ done: true });
    });

    it("parses an error frame", () => {
        expect(parseFrame('{"error":"model request failed"}')).toEqual({
            error: "model request failed",
        });
    });

    it("parses an authResult frame", () => {
        expect(
            parseFrame('{"authResult":{"user":"luke","device":"macbook"}}'),
        ).toEqual({ authResult: { user: "luke", device: "macbook" } });
    });

    it("throws on non-JSON payloads", () => {
        expect(() => parseFrame("{not json")).toThrow(/malformed/);
    });

    it("throws on unrecognized shapes", () => {
        expect(() => parseFrame('{"nope":1}')).toThrow(/unrecognized/);
        expect(() => parseFrame('{"chunk":42}')).toThrow(/unrecognized/);
        expect(() => parseFrame('{"tool":{"name":7}}')).toThrow(/unrecognized/);
        expect(() => parseFrame('{"done":"yes"}')).toThrow(/unrecognized/);
        expect(() => parseFrame('{"error":true}')).toThrow(/unrecognized/);
        expect(() => parseFrame('{"authResult":{"user":"luke"}}')).toThrow(
            /unrecognized/,
        );
    });
});

describe("serializeFrame round-trips", () => {
    const frames: ServerFrame[] = [
        { chunk: "Hello" },
        { tool: { name: "getCurrentTime", args: {} } },
        { tool: { name: "calculate" } },
        { toolResult: { name: "search", output: "results" } },
        { done: true },
        { error: "boom" },
        { authResult: { user: "luke", device: "macbook" } },
    ];
    for (const frame of frames) {
        it(`round-trips ${Object.keys(frame)[0]} frames`, () => {
            expect(parseFrame(serializeFrame(frame))).toEqual(frame);
        });
    }
});

describe("parseRequest", () => {
    it("parses a valid request", () => {
        expect(parseRequest('{"prompt":"hi","sessionId":"abc"}')).toEqual({
            prompt: "hi",
            sessionId: "abc",
        });
    });

    it("throws on non-JSON payloads", () => {
        expect(() => parseRequest("nope")).toThrow(/malformed/);
    });

    it("rejects a missing or empty prompt", () => {
        expect(() => parseRequest('{"sessionId":"abc"}')).toThrow(/prompt/);
        expect(() => parseRequest('{"prompt":"  ","sessionId":"abc"}')).toThrow(
            /prompt/,
        );
    });

    it("rejects a missing or empty sessionId", () => {
        expect(() => parseRequest('{"prompt":"hi"}')).toThrow(/sessionId/);
        expect(() => parseRequest('{"prompt":"hi","sessionId":" "}')).toThrow(
            /sessionId/,
        );
    });

    it("rejects an over-long sessionId", () => {
        const sessionId = "x".repeat(MAX_SESSION_ID_LENGTH + 1);
        expect(() =>
            parseRequest(JSON.stringify({ prompt: "hi", sessionId })),
        ).toThrow(/at most/);
    });

    it("accepts a sessionId of exactly MAX_SESSION_ID_LENGTH", () => {
        const sessionId = "x".repeat(MAX_SESSION_ID_LENGTH);
        expect(
            parseRequest(JSON.stringify({ prompt: "hi", sessionId })),
        ).toEqual({ prompt: "hi", sessionId });
    });
});

describe("serializeRequest", () => {
    it("serializes prompt and sessionId as JSON", () => {
        expect(JSON.parse(serializeRequest("hi", "abc"))).toEqual({
            prompt: "hi",
            sessionId: "abc",
        });
    });
});

describe("parseClientMessage", () => {
    it("parses an auth handshake", () => {
        expect(parseClientMessage('{"type":"auth","token":"abc123"}')).toEqual({
            type: "auth",
            token: "abc123",
        });
    });

    it("rejects an auth handshake without a token", () => {
        expect(() => parseClientMessage('{"type":"auth"}')).toThrow(/token/);
    });

    it("rejects an auth handshake with an empty token", () => {
        expect(() =>
            parseClientMessage('{"type":"auth","token":"  "}'),
        ).toThrow(/token/);
    });

    it("rejects an over-long token", () => {
        const token = "x".repeat(MAX_TOKEN_LENGTH + 1);
        expect(() =>
            parseClientMessage(JSON.stringify({ type: "auth", token })),
        ).toThrow(/at most/);
    });

    it("accepts a token of exactly MAX_TOKEN_LENGTH", () => {
        const token = "x".repeat(MAX_TOKEN_LENGTH);
        expect(
            parseClientMessage(JSON.stringify({ type: "auth", token })),
        ).toEqual({ type: "auth", token });
    });

    it("parses a legacy prompt frame", () => {
        expect(parseClientMessage('{"prompt":"hi","sessionId":"abc"}')).toEqual(
            { prompt: "hi", sessionId: "abc" },
        );
    });

    it("rejects a prompt-shaped message with an invalid prompt field", () => {
        expect(() => parseClientMessage('{"sessionId":"abc"}')).toThrow(
            /prompt/,
        );
    });

    it("rejects a prompt-shaped message with an invalid sessionId field", () => {
        expect(() => parseClientMessage('{"prompt":"hi"}')).toThrow(
            /sessionId/,
        );
    });

    it("throws on non-JSON payloads", () => {
        expect(() => parseClientMessage("nope")).toThrow(/malformed/);
    });
});

describe("parseClientMessage: hello capability frames", () => {
    it("parses a hello with declared capabilities", () => {
        expect(
            parseClientMessage(
                '{"type":"hello","capabilities":["markdown","image","link"]}',
            ),
        ).toEqual({
            type: "hello",
            capabilities: ["markdown", "image", "link"],
        });
    });

    it("accepts an empty capabilities list (plain-text client)", () => {
        expect(
            parseClientMessage('{"type":"hello","capabilities":[]}'),
        ).toEqual({ type: "hello", capabilities: [] });
    });

    it("rejects duplicate capability tokens", () => {
        expect(() =>
            parseClientMessage(
                '{"type":"hello","capabilities":["markdown","markdown"]}',
            ),
        ).toThrow(/duplicate capability 'markdown'/);
    });

    it("rejects a hello without a capabilities array", () => {
        expect(() => parseClientMessage('{"type":"hello"}')).toThrow(
            /capabilities/,
        );
        expect(() =>
            parseClientMessage('{"type":"hello","capabilities":"markdown"}'),
        ).toThrow(/capabilities/);
    });

    it("rejects unknown capability tokens", () => {
        expect(() =>
            parseClientMessage('{"type":"hello","capabilities":["hologram"]}'),
        ).toThrow(/unknown capability 'hologram'/);
    });

    it("rejects non-string capability entries", () => {
        expect(() =>
            parseClientMessage('{"type":"hello","capabilities":[42]}'),
        ).toThrow(/non-empty string/);
    });

    it("rejects a capabilities list over MAX_CAPABILITIES long", () => {
        const caps = Array(MAX_CAPABILITIES + 1).fill("markdown") as string[];
        expect(() =>
            parseClientMessage(
                JSON.stringify({ type: "hello", capabilities: caps }),
            ),
        ).toThrow(/at most/);
    });

    it("rejects a capability token over MAX_CAPABILITY_LENGTH", () => {
        const token = "x".repeat(MAX_CAPABILITY_LENGTH + 1);
        expect(() =>
            parseClientMessage(
                JSON.stringify({ type: "hello", capabilities: [token] }),
            ),
        ).toThrow(/each capability is at most 16 characters/);
    });
});

describe("serializeHello", () => {
    it("round-trips through parseClientMessage", () => {
        const caps: ClientCapability[] = ["markdown", "link"];
        expect(parseClientMessage(serializeHello(caps))).toEqual({
            type: "hello",
            capabilities: caps,
        });
    });

    it("round-trips an empty capabilities list", () => {
        expect(parseClientMessage(serializeHello([]))).toEqual({
            type: "hello",
            capabilities: [],
        });
    });
});

describe("serializeAuth", () => {
    it("round-trips through parseClientMessage", () => {
        expect(parseClientMessage(serializeAuth("secret-abc"))).toEqual({
            type: "auth",
            token: "secret-abc",
        });
    });
});
