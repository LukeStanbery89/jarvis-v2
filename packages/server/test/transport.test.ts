import { describe, expect, it } from "vitest";
import type { ServerFrame } from "@lukestanbery/jarvis-protocol";
import { toServerFrame } from "../src/transport";

describe("toServerFrame", () => {
    it("maps a token event to a chunk frame", () => {
        expect(toServerFrame({ type: "token", text: "Hello" })).toEqual({
            chunk: "Hello",
        });
    });

    it("maps a tool event to a tool frame", () => {
        expect(
            toServerFrame({ type: "tool", name: "getCurrentTime", args: {} }),
        ).toEqual({ tool: { name: "getCurrentTime", args: {} } });
    });

    it("maps a tool event without args to a tool frame without args", () => {
        expect(
            toServerFrame({ type: "tool", name: "nudge", args: undefined }),
        ).toEqual({ tool: { name: "nudge", args: undefined } });
    });

    it("maps a toolResult event to a toolResult frame", () => {
        expect(
            toServerFrame({
                type: "toolResult",
                name: "getCurrentTime",
                output: "2026-09-20T00:00:00.000Z",
            }),
        ).toEqual({
            toolResult: {
                name: "getCurrentTime",
                output: "2026-09-20T00:00:00.000Z",
            },
        });
    });

    it("always yields a valid ServerFrame (compile-time exhaustiveness guard)", () => {
        const frames: ServerFrame[] = [
            toServerFrame({ type: "token", text: "" }),
            toServerFrame({ type: "tool", name: "a", args: {} }),
            toServerFrame({
                type: "toolResult",
                name: "a",
                output: undefined,
            }),
        ];
        expect(frames).toHaveLength(3);
    });
});
