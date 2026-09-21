import { describe, expect, it } from "vitest";
import { parseFrame } from "../src/client";

describe("parseFrame", () => {
    it("parses a chunk frame", () => {
        expect(parseFrame('{"chunk":"Hello, World!"}')).toEqual({
            type: "chunk",
            text: "Hello, World!",
        });
    });

    it("parses a tool frame", () => {
        expect(
            parseFrame('{"tool":{"name":"getCurrentTime","args":{}}}'),
        ).toEqual({ type: "tool", name: "getCurrentTime", args: {} });
    });

    it("parses a tool frame with no args", () => {
        expect(parseFrame('{"tool":{"name":"calculate"}}')).toEqual({
            type: "tool",
            name: "calculate",
            args: undefined,
        });
    });

    it("parses a toolResult frame", () => {
        expect(
            parseFrame(
                '{"toolResult":{"name":"getCurrentTime","output":"2026-09-20T00:00:00Z"}}',
            ),
        ).toEqual({
            type: "toolResult",
            name: "getCurrentTime",
            output: "2026-09-20T00:00:00Z",
        });
    });

    it("parses a done frame", () => {
        expect(parseFrame('{"done":true}')).toEqual({ type: "done" });
    });

    it("parses an error frame", () => {
        expect(parseFrame('{"error":"model request failed"}')).toEqual({
            type: "error",
            message: "model request failed",
        });
    });

    it("throws on malformed JSON", () => {
        expect(() => parseFrame("{not json")).toThrow(/malformed/);
    });

    it("throws on an unrecognized frame", () => {
        expect(() => parseFrame('{"nope":1}')).toThrow(/unrecognized/);
    });

    it("throws when a known key carries the wrong type", () => {
        expect(() => parseFrame('{"chunk":42}')).toThrow(/unrecognized/);
        expect(() => parseFrame('{"tool":{"name":7}}')).toThrow(/unrecognized/);
        expect(() => parseFrame('{"done":"yes"}')).toThrow(/unrecognized/);
        expect(() => parseFrame('{"error":true}')).toThrow(/unrecognized/);
    });
});
