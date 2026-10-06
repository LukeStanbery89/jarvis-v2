import { describe, expect, it } from "vitest";
import {
    MAX_ATTACHMENTS,
    MAX_ATTACHMENT_ID_LENGTH,
    MAX_CAPABILITIES,
    MAX_CAPABILITY_LENGTH,
    MAX_LOCATION_LABEL_LENGTH,
    MAX_SESSION_ID_LENGTH,
    MAX_TOKEN_LENGTH,
    parseClientMessage,
    parseFrame,
    parseRequest,
    serializeAuth,
    serializeFrame,
    serializeHello,
    serializeLocation,
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

    it("omits mode when absent", () => {
        const parsed = parseRequest('{"prompt":"hi","sessionId":"abc"}');
        expect(parsed.mode).toBeUndefined();
    });

    it.each(["text", "voice"] as const)(
        "parses a prompt with an explicit %s mode",
        (mode) => {
            const parsed = parseRequest(
                JSON.stringify({ prompt: "hi", sessionId: "abc", mode }),
            );
            expect(parsed.mode).toBe(mode);
        },
    );

    it("rejects an unknown chat mode", () => {
        expect(() =>
            parseRequest('{"prompt":"hi","sessionId":"abc","mode":"video"}'),
        ).toThrow("expected 'mode' to be 'text' or 'voice'");
    });

    it("rejects a non-string chat mode", () => {
        expect(() =>
            parseRequest('{"prompt":"hi","sessionId":"abc","mode":42}'),
        ).toThrow("expected 'mode' to be 'text' or 'voice'");
    });

    it("omits attachments when absent", () => {
        const parsed = parseRequest('{"prompt":"hi","sessionId":"abc"}');
        expect(parsed).toEqual({ prompt: "hi", sessionId: "abc" });
        expect("attachments" in parsed).toBe(false);
    });

    it("accepts an attachments list within bounds", () => {
        const id = "A".repeat(24);
        expect(
            parseRequest(
                JSON.stringify({
                    prompt: "hi",
                    sessionId: "abc",
                    attachments: [id, "B".repeat(24)],
                }),
            ),
        ).toEqual({
            prompt: "hi",
            sessionId: "abc",
            attachments: [id, "B".repeat(24)],
        });
    });

    it("accepts an id of exactly MAX_ATTACHMENT_ID_LENGTH", () => {
        const id = "A".repeat(MAX_ATTACHMENT_ID_LENGTH);
        expect(
            parseRequest(
                JSON.stringify({
                    prompt: "hi",
                    sessionId: "abc",
                    attachments: [id],
                }),
            ).attachments,
        ).toEqual([id]);
    });

    it("accepts an empty attachments list", () => {
        expect(
            parseRequest('{"prompt":"hi","sessionId":"abc","attachments":[]}'),
        ).toEqual({ prompt: "hi", sessionId: "abc", attachments: [] });
    });

    it("rejects a non-array attachments field", () => {
        expect(() =>
            parseRequest('{"prompt":"hi","sessionId":"abc","attachments":"x"}'),
        ).toThrow("expected 'attachments' to be an array of ids");
    });

    it("rejects more than MAX_ATTACHMENTS ids", () => {
        const ids = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) =>
            `${i}`.repeat(24),
        );
        expect(() =>
            parseRequest(
                JSON.stringify({
                    prompt: "hi",
                    sessionId: "abc",
                    attachments: ids,
                }),
            ),
        ).toThrow(`at most ${MAX_ATTACHMENTS} attachments may be referenced`);
    });

    it("rejects a non-string attachment id", () => {
        expect(() =>
            parseRequest(
                '{"prompt":"hi","sessionId":"abc","attachments":[42]}',
            ),
        ).toThrow("every attachment id must be a non-empty string");
    });

    it("rejects an empty attachment id", () => {
        expect(() =>
            parseRequest(
                '{"prompt":"hi","sessionId":"abc","attachments":[""]}',
            ),
        ).toThrow("every attachment id must be a non-empty string");
    });

    it("rejects an id over MAX_ATTACHMENT_ID_LENGTH", () => {
        expect(() =>
            parseRequest(
                JSON.stringify({
                    prompt: "hi",
                    sessionId: "abc",
                    attachments: ["A".repeat(MAX_ATTACHMENT_ID_LENGTH + 1)],
                }),
            ),
        ).toThrow("each attachment id is at most 32 characters");
    });

    it("rejects a duplicate attachment id", () => {
        const id = "A".repeat(24);
        expect(() =>
            parseRequest(
                JSON.stringify({
                    prompt: "hi",
                    sessionId: "abc",
                    attachments: [id, id],
                }),
            ),
        ).toThrow(`duplicate attachment id '${id}'`);
    });
});

describe("serializeRequest", () => {
    it("serializes prompt and sessionId as JSON", () => {
        expect(JSON.parse(serializeRequest("hi", "abc"))).toEqual({
            prompt: "hi",
            sessionId: "abc",
        });
    });

    it("keeps the two-argument wire shape byte-identical (no mode key)", () => {
        expect(serializeRequest("hi", "abc")).toBe(
            '{"prompt":"hi","sessionId":"abc"}',
        );
    });

    it("serializes an explicit voice mode", () => {
        expect(serializeRequest("hi", "abc", { mode: "voice" })).toBe(
            '{"prompt":"hi","sessionId":"abc","mode":"voice"}',
        );
    });

    it("serializes an explicit text mode", () => {
        expect(serializeRequest("hi", "abc", { mode: "text" })).toBe(
            '{"prompt":"hi","sessionId":"abc","mode":"text"}',
        );
    });

    it("serializes referenced attachments as an id array", () => {
        expect(
            serializeRequest("hi", "abc", {
                attachments: [
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                    "BBBBBBBBBBBBBBBBBBBBBBBBBBBB",
                ],
            }),
        ).toBe(
            '{"prompt":"hi","sessionId":"abc","attachments":["AAAAAAAAAAAAAAAAAAAAAAAAAAAA","BBBBBBBBBBBBBBBBBBBBBBBBBBBB"]}',
        );
    });

    it("omits an empty attachments list from the wire shape", () => {
        expect(serializeRequest("hi", "abc", { attachments: [] })).toBe(
            '{"prompt":"hi","sessionId":"abc"}',
        );
    });

    it("round-trips an attachment-carrying prompt through the parser", () => {
        const raw = serializeRequest("hi", "abc", {
            mode: "voice",
            attachments: ["AAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
        });
        expect(parseRequest(raw)).toEqual({
            prompt: "hi",
            sessionId: "abc",
            mode: "voice",
            attachments: ["AAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
        });
    });

    it("round-trips a mode-carrying prompt through the parser", () => {
        const raw = serializeRequest("hi", "abc", { mode: "voice" });
        expect(parseRequest(raw).mode).toBe("voice");
        expect(parseClientMessage(raw)).toEqual({
            prompt: "hi",
            sessionId: "abc",
            mode: "voice",
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

    it("parses a prompt frame with a voice mode", () => {
        expect(
            parseClientMessage(
                '{"prompt":"hi","sessionId":"abc","mode":"voice"}',
            ),
        ).toEqual({ prompt: "hi", sessionId: "abc", mode: "voice" });
    });

    it("rejects a prompt frame with an unknown mode", () => {
        expect(() =>
            parseClientMessage(
                '{"prompt":"hi","sessionId":"abc","mode":"video"}',
            ),
        ).toThrow("expected 'mode' to be 'text' or 'voice'");
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

describe("parseClientMessage: location frames (#31)", () => {
    it("parses a location report without a label", () => {
        expect(
            parseClientMessage(
                '{"type":"location","lat":45.5231,"lon":-122.6765}',
            ),
        ).toEqual({ type: "location", lat: 45.5231, lon: -122.6765 });
    });

    it("parses a location report with a label", () => {
        expect(
            parseClientMessage(
                '{"type":"location","lat":45.5231,"lon":-122.6765,"label":"Portland, OR"}',
            ),
        ).toEqual({
            type: "location",
            lat: 45.5231,
            lon: -122.6765,
            label: "Portland, OR",
        });
    });

    it("accepts the geographic range boundaries", () => {
        expect(
            parseClientMessage('{"type":"location","lat":90,"lon":180}'),
        ).toEqual({ type: "location", lat: 90, lon: 180 });
        expect(
            parseClientMessage('{"type":"location","lat":-90,"lon":-180}'),
        ).toEqual({ type: "location", lat: -90, lon: -180 });
    });

    it("rejects a missing latitude", () => {
        expect(() => parseClientMessage('{"type":"location","lon":0}')).toThrow(
            /lat/,
        );
    });

    it("rejects a missing longitude", () => {
        expect(() => parseClientMessage('{"type":"location","lat":0}')).toThrow(
            /lon/,
        );
    });

    it("rejects a non-number latitude", () => {
        expect(() =>
            parseClientMessage('{"type":"location","lat":"45","lon":0}'),
        ).toThrow(/lat/);
    });

    it.each([
        ["over the north pole", 90.0001],
        ["under the south pole", -90.0001],
    ])("rejects a latitude %s", (_name, lat) => {
        expect(() =>
            parseClientMessage(
                JSON.stringify({ type: "location", lat, lon: 0 }),
            ),
        ).toThrow(/finite 'lat' between -90 and 90/);
    });

    it.each([
        ["past the antimeridian east", 180.0001],
        ["past the antimeridian west", -180.0001],
    ])("rejects a longitude %s", (_name, lon) => {
        expect(() =>
            parseClientMessage(
                JSON.stringify({ type: "location", lat: 0, lon }),
            ),
        ).toThrow(/finite 'lon' between -180 and 180/);
    });

    it("rejects a non-finite latitude (1e999 overflows to Infinity)", () => {
        expect(() =>
            parseClientMessage('{"type":"location","lat":1e999,"lon":0}'),
        ).toThrow(/finite 'lat'/);
    });

    it("rejects a whitespace-only label", () => {
        expect(() =>
            parseClientMessage(
                '{"type":"location","lat":0,"lon":0,"label":"   "}',
            ),
        ).toThrow(/non-empty string/);
    });

    it("rejects a non-string label", () => {
        expect(() =>
            parseClientMessage('{"type":"location","lat":0,"lon":0,"label":7}'),
        ).toThrow(/non-empty string/);
    });

    it("rejects a label over MAX_LOCATION_LABEL_LENGTH", () => {
        expect(() =>
            parseClientMessage(
                JSON.stringify({
                    type: "location",
                    lat: 0,
                    lon: 0,
                    label: "x".repeat(MAX_LOCATION_LABEL_LENGTH + 1),
                }),
            ),
        ).toThrow(/at most 64 characters/);
    });

    it("accepts a label of exactly MAX_LOCATION_LABEL_LENGTH", () => {
        const label = "x".repeat(MAX_LOCATION_LABEL_LENGTH);
        expect(
            parseClientMessage(
                JSON.stringify({ type: "location", lat: 0, lon: 0, label }),
            ),
        ).toEqual({ type: "location", lat: 0, lon: 0, label });
    });
});

describe("serializeLocation", () => {
    it("round-trips without a label through parseClientMessage", () => {
        expect(
            parseClientMessage(serializeLocation(45.5231, -122.6765)),
        ).toEqual({ type: "location", lat: 45.5231, lon: -122.6765 });
    });

    it("round-trips with a label through parseClientMessage", () => {
        expect(
            parseClientMessage(
                serializeLocation(45.5231, -122.6765, "Portland"),
            ),
        ).toEqual({
            type: "location",
            lat: 45.5231,
            lon: -122.6765,
            label: "Portland",
        });
    });

    it("omits an absent label from the wire shape", () => {
        expect(serializeLocation(0, 0)).toBe(
            '{"type":"location","lat":0,"lon":0}',
        );
    });
});
