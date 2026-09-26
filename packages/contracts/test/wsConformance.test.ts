/**
 * Frame-conformance tests: prove `@lukestanbery/jarvis-protocol` and the
 * AsyncAPI spec (`spec/asyncapi.yaml`) cannot drift apart.
 *
 * Every frame the protocol can serialize must validate against the matching
 * message payload schema in the spec, and every frame the protocol parser
 * rejects must also be rejected by the spec. Net effect:
 *
 * - a frame shape/rename/constant change in `packages/protocol` changes what
 *   the serializers emit or the parser accepts → this suite fails until the
 *   spec is updated in the same change;
 * - a message rename or shape change in `spec/asyncapi.yaml` → the messages
 *   here stop matching the real frames → this suite fails until the protocol
 *   is updated in the same change.
 *
 * Frames are produced through the protocol's own serializers (never
 * hand-written in this file), so these fixtures cannot go stale against the
 * protocol. Representative real frames are mirrored from the server's
 * `transport.test.ts` / `ws.test.ts` (chunk with content, empty chunk,
 * tool with and without `args`, `toolResult` with and without `output`).
 */
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Parser } from "@asyncapi/parser";
import Ajv from "ajv";
import {
    MAX_SESSION_ID_LENGTH,
    MAX_TOKEN_LENGTH,
    parseClientMessage,
    parseFrame,
    serializeAuth,
    serializeFrame,
    serializeRequest,
} from "@lukestanbery/jarvis-protocol";
import type { ServerFrame } from "@lukestanbery/jarvis-protocol";
import { ASYNCAPI_SPEC } from "../src";

// Vitest runs from the package root (npm workspaces), so `process.cwd()` is
// the package directory.
const packageRoot = process.cwd();

type PayloadSchema = Record<string, unknown>;

/** The exact message set the spec must declare (message name ↔ frame key). */
const MESSAGES = [
    "authResult",
    "authHandshake",
    "chatPrompt",
    "chunk",
    "done",
    "error",
    "toolCall",
    "toolResult",
];

// ---------------------------------------------------------------------------
// Spec loading
// ---------------------------------------------------------------------------

let schemas: Record<string, PayloadSchema>;

beforeAll(async () => {
    const spec = await new Parser().parse(
        fs.readFileSync(path.join(packageRoot, ASYNCAPI_SPEC), "utf8"),
    );
    const document = spec.document;
    if (!document) {
        throw new Error("AsyncAPI spec did not parse to a document");
    }
    const raw = document.json();
    const messages =
        (
            raw as {
                components?: {
                    messages?: Record<string, { payload?: unknown }>;
                };
            }
        ).components?.messages ?? {};
    expect(Object.keys(messages).sort()).toEqual([...MESSAGES].sort());
    schemas = Object.fromEntries(
        Object.entries(messages).map(([name, message]) => [
            name,
            message.payload as PayloadSchema,
        ]),
    );
    expect(Object.keys(schemas)).toHaveLength(MESSAGES.length);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ajv = new Ajv({ strict: false, allErrors: true });

/** Validates `data` against the payload schema for message `name`. */
function expectSpecValid(name: string, data: unknown): void {
    const valid = ajv.validate(schemas[name], data);
    expect(
        { valid, errors: ajv.errors },
        `${name} payload does not match the spec: ${JSON.stringify(data)}`,
    ).toMatchObject({ valid: true });
}

/** Serializes via the protocol, then checks the spec accepts the wire text. */
function expectWireConformant(serialize: () => string, name: string): void {
    const text = serialize();
    expectSpecValid(name, JSON.parse(text));
}

/** The spec must reject `data` for message `name`. */
function expectSpecRejects(name: string, data: unknown): void {
    const valid = ajv.validate(schemas[name], data);
    expect(
        { valid, errors: ajv.errors },
        `${name} payload unexpectedly matches the spec: ${JSON.stringify(data)}`,
    ).toMatchObject({ valid: false });
}

// ---------------------------------------------------------------------------
// Positive: every serializable protocol frame validates against the spec
// ---------------------------------------------------------------------------

describe("AsyncAPI conformance: protocol frames", () => {
    describe("client → server", () => {
        it("validates an auth handshake through the serializer", () => {
            expectWireConformant(
                () => serializeAuth("dvt_really-valid-token"),
                "authHandshake",
            );
        });

        it("validates a chat prompt through the serializer", () => {
            expectWireConformant(
                () => serializeRequest("Hello", "s-morning"),
                "chatPrompt",
            );
        });

        it("validates a prompt whose sessionId sits at the max length", () => {
            const sid = "s".repeat(MAX_SESSION_ID_LENGTH);
            expectWireConformant(
                () => serializeRequest("hi", sid),
                "chatPrompt",
            );
        });

        it("validates a token at the max length", () => {
            expectWireConformant(
                () => serializeAuth("t".repeat(MAX_TOKEN_LENGTH)),
                "authHandshake",
            );
        });
    });

    describe("server → client (real frames from the server transport)", () => {
        it("validates a chunk frame (with content, as streamed)", () => {
            const frame: ServerFrame = { chunk: "This is a streamed chunk. " };
            expectWireConformant(() => serializeFrame(frame), "chunk");
        });

        it("validates a tool frame with args (getCurrentTime)", () => {
            const frame: ServerFrame = {
                tool: { name: "getCurrentTime", args: {} },
            };
            expectWireConformant(() => serializeFrame(frame), "toolCall");
        });

        it("validates a tool frame without args (JSON drops undefined)", () => {
            const frame: ServerFrame = {
                tool: { name: "nudge", args: undefined },
            };
            expectWireConformant(() => serializeFrame(frame), "toolCall");
        });

        it("validates a toolResult frame with output", () => {
            const frame: ServerFrame = {
                toolResult: {
                    name: "getCurrentTime",
                    output: "2026-09-20T00:00:00.000Z",
                },
            };
            expectWireConformant(() => serializeFrame(frame), "toolResult");
        });

        it("validates a done frame", () => {
            const frame: ServerFrame = { done: true };
            expectWireConformant(() => serializeFrame(frame), "done");
        });

        it("validates an error frame (ws.ts wording)", () => {
            const frame: ServerFrame = {
                error: "another request is already in progress",
            };
            expectWireConformant(() => serializeFrame(frame), "error");
        });

        it("validates an authResult frame (ws.test.ts exchange)", () => {
            const frame: ServerFrame = {
                authResult: { user: "luke", device: "macbook" },
            };
            expectWireConformant(() => serializeFrame(frame), "authResult");
        });
    });

    describe("parser round-trip", () => {
        it("every spec-valid server frame I serialize is accepted by parseFrame", () => {
            const frames: ServerFrame[] = [
                { chunk: "" },
                { tool: { name: "a", args: {} } },
                { tool: { name: "a" } }, // args omitted in wire form
                { toolResult: { name: "a", output: {} } },
                { toolResult: { name: "a" } },
                { done: true },
                { error: "" },
                { authResult: { user: "u", device: "d" } },
            ];
            for (const frame of frames) {
                const text = serializeFrame(frame);
                expect(() => parseFrame(text)).not.toThrow();
            }
        });

        it("every client frame I serialize is accepted by parseClientMessage", () => {
            expect(() => parseClientMessage(serializeAuth("t"))).not.toThrow();
            expect(() =>
                parseClientMessage(serializeRequest("hi", "s")),
            ).not.toThrow();
        });
    });
});

// ---------------------------------------------------------------------------
// Negative: what the protocol parser rejects, the spec must reject too
// ---------------------------------------------------------------------------

describe("AsyncAPI conformance: spec rejects protocol-invalid frames", () => {
    it("rejects a sessionId longer than MAX_SESSION_ID_LENGTH", () => {
        expectSpecRejects("chatPrompt", {
            prompt: "hi",
            sessionId: "s".repeat(MAX_SESSION_ID_LENGTH + 1),
        });
    });

    it("rejects a token longer than MAX_TOKEN_LENGTH", () => {
        expectSpecRejects("authHandshake", {
            type: "auth",
            token: "t".repeat(MAX_TOKEN_LENGTH + 1),
        });
    });

    it("rejects a whitespace-only sessionId (protocol trims, spec's \\S rejects)", () => {
        expectSpecRejects("chatPrompt", { prompt: "hi", sessionId: "   " });
    });

    it("rejects a non-string chunk", () => {
        expectSpecRejects("chunk", { chunk: 5 });
    });

    it("rejects a done frame that is not exactly true", () => {
        expectSpecRejects("done", { done: "yes" });
    });

    it("rejects an authResult missing its device", () => {
        expectSpecRejects("authResult", { authResult: { user: "luke" } });
    });

    it("rejects a tool frame with a non-object payload", () => {
        expectSpecRejects("toolCall", { tool: "getCurrentTime" });
    });

    it("rejects an unknown frame shape entirely (no discriminator)", () => {
        expectSpecRejects("error", { surprise: true });
    });
});
