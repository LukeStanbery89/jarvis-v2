/**
 * Frame-conformance tests: prove `@lukestanbery/jarvis-protocol` and the
 * AsyncAPI spec (`spec/asyncapi.yaml`) cannot drift apart.
 *
 * Every frame the protocol can serialize must validate against the matching
 * message payload schema in the spec, and the frames this suite covers that
 * the protocol parser rejects must also be rejected by the spec. Net effect:
 *
 * - a frame shape/rename/constant change in `packages/protocol` changes what
 *   the serializers emit or the parser accepts → this suite fails until the
 *   spec is updated in the same change;
 * - a message rename or shape change in `spec/asyncapi.yaml` → the messages
 *   here stop matching the real frames → this suite fails until the protocol
 *   is updated in the same change.
 *
 * The scope is deliberately not "every frame the parser rejects": the spec is
 * stricter than the parser (unknown keys are `additionalProperties: false`)
 * and that strictness is pinned explicitly, not mirrored.
 *
 * Frames are produced through the protocol's own serializers (never
 * hand-written in this file), so these fixtures cannot go stale against the
 * protocol. Representative real frames are mirrored exactly from the server's
 * `transport.test.ts` / `ws.test.ts` (chunk "Hello", tool with and without
 * `args`, `toolResult` with and without `output`, the `ws.ts` in-progress
 * error wording, the `authResult` from a `ws.test.ts` exchange).
 */
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Parser } from "@asyncapi/parser";
import Ajv from "ajv";
import { load as loadYaml } from "js-yaml";
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

/**
 * Compile-link the message names to the protocol's frame types: renames a
 * `ServerFrame` variant in `packages/protocol` make the `satisfies` below a
 * type error, catching the one hand-written literal the runtime tests cannot.
 */
type FrameKeys<T> = T extends unknown ? keyof T : never;

/** The 6 server-frame discriminator keys, checked against `ServerFrame`. */
const SERVER_FRAME_KEYS = [
    "chunk",
    "tool",
    "toolResult",
    "done",
    "error",
    "authResult",
] as const satisfies readonly FrameKeys<ServerFrame>[];

/** Client message names (not a `ClientFrame` key — it is a union of two shapes). */
const CLIENT_MESSAGE_NAMES = ["authHandshake", "chatPrompt"] as const;

/**
 * The spec's message name for each server-frame discriminator key. The spec
 * names frames for their docs (`toolCall` for the `tool` frame), so this map
 * bridges protocol key → spec message name.
 */
const MESSAGE_FOR_KEY: Record<string, string> = {
    chunk: "chunk",
    tool: "toolCall",
    toolResult: "toolResult",
    done: "done",
    error: "error",
    authResult: "authResult",
};

/** The exact message set the spec must declare (spec-side names). */
const MESSAGE_NAMES = [
    ...CLIENT_MESSAGE_NAMES,
    ...Object.values(MESSAGE_FOR_KEY),
] as const;

/** Message names on the client side of `/ws` map 1:1. */
const MESSAGE_FOR_CLIENT: Record<string, string> = {
    authHandshake: "authHandshake",
    chatPrompt: "chatPrompt",
};

// ---------------------------------------------------------------------------
// Spec loading
// ---------------------------------------------------------------------------

let schemas: Record<string, PayloadSchema>;

beforeAll(async () => {
    const text = fs.readFileSync(path.join(packageRoot, ASYNCAPI_SPEC), "utf8");
    const spec = await new Parser().parse(text);
    expect(spec.diagnostics.filter((d) => d.severity === 0)).toEqual([]);
    const document = spec.document;
    if (!document) {
        throw new Error("AsyncAPI spec did not parse to a document");
    }

    // Membership guards run on the authored YAML (the parser resolves $refs,
    // so `operations[].messages` lose their references in `json()`).
    const doc = loadYaml(text) as {
        components?: { messages?: Record<string, unknown> };
        operations?: Record<string, { messages?: Array<{ $ref: string }> }>;
    };
    const messages = doc.components?.messages ?? {};
    expect(Object.keys(messages).sort()).toEqual([...MESSAGE_NAMES].sort());
    schemas = Object.fromEntries(
        Object.entries(
            document.json().components?.messages ??
                ({} as Record<string, { payload?: unknown }>),
        ).map(([name, message]) => [
            name,
            (message as { payload?: unknown }).payload as PayloadSchema,
        ]),
    );

    // The two operations must reference exactly the messages above — guarding
    // the channel-side wiring, not just `components.messages`.
    const operationRefs = Object.values(doc.operations ?? {})
        .flatMap((op) => op.messages ?? [])
        .map((m) => (m.$ref.split("/").pop() as string).trim())
        .filter(Boolean)
        .sort();
    expect(operationRefs).toEqual([...MESSAGE_NAMES].sort());

    // Every server-frame discriminator key maps to a spec message.
    expect(
        SERVER_FRAME_KEYS.filter((key) => !(key in MESSAGE_FOR_KEY)),
    ).toEqual([]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The parser injects `x-parser-schema-id` into payload schemas. Register the
// keyword so ajv stays strict — strict mode then keeps catching typo'd
// schema keywords, which strict-mode-off would silently accept.
const ajv = new Ajv({ allErrors: true });
ajv.addKeyword({ keyword: "x-parser-schema-id" });

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

/**
 * Asserts both halves of a rejection: the wire text trips the protocol
 * parser (`parse`), and its parsed payload trips the spec schema for
 * `name`. Keeps the two sides locked on every negative case.
 */
function expectBothReject(
    name: string,
    wire: string,
    parse: (text: string) => unknown,
): void {
    expectSpecRejects(name, JSON.parse(wire));
    expect(
        () => parse(wire),
        `${name}: protocol parser accepted ${wire}`,
    ).toThrow();
}

/** Wire-encodes a client frame (parses through `parseClientMessage`). */
const asClient = (obj: Record<string, unknown>) => JSON.stringify(obj);

/** Wire-encodes a server frame (parses through `parseFrame`). */
const asFrame = (obj: Record<string, unknown>) => JSON.stringify(obj);

// ---------------------------------------------------------------------------
// Positive: every serializable protocol frame validates against the spec
// ---------------------------------------------------------------------------

describe("AsyncAPI conformance: protocol frames", () => {
    describe("client → server", () => {
        it("validates an auth handshake through the serializer", () => {
            expectWireConformant(
                () => serializeAuth("4OdRyD3LeTT3rAaBbCcDdEeFfGgHhIiJjKkLlM"),
                MESSAGE_FOR_CLIENT.authHandshake,
            );
        });

        it("validates a token at the max length", () => {
            expectWireConformant(
                () => serializeAuth("t".repeat(MAX_TOKEN_LENGTH)),
                MESSAGE_FOR_CLIENT.authHandshake,
            );
        });

        it("validates a chat prompt through the serializer", () => {
            expectWireConformant(
                () => serializeRequest("Hello", "s-morning"),
                MESSAGE_FOR_CLIENT.chatPrompt,
            );
        });

        it("validates a prompt whose sessionId sits at the max length", () => {
            const sid = "s".repeat(MAX_SESSION_ID_LENGTH);
            expectWireConformant(
                () => serializeRequest("hi", sid),
                MESSAGE_FOR_CLIENT.chatPrompt,
            );
        });
    });

    describe("server → client (real frames from the server transport)", () => {
        it("validates a chunk frame (transport.test.ts: 'Hello')", () => {
            const frame: ServerFrame = { chunk: "Hello" };
            expectWireConformant(
                () => serializeFrame(frame),
                MESSAGE_FOR_KEY.chunk,
            );
        });

        it("validates a tool frame with args (getCurrentTime)", () => {
            const frame: ServerFrame = {
                tool: { name: "getCurrentTime", args: {} },
            };
            expectWireConformant(
                () => serializeFrame(frame),
                MESSAGE_FOR_KEY.tool,
            );
        });

        it("validates a tool frame without args (JSON drops undefined)", () => {
            const wire = serializeFrame({
                tool: { name: "nudge", args: undefined },
            });
            expect(JSON.parse(wire).tool).not.toHaveProperty("args");
            expectSpecValid(MESSAGE_FOR_KEY.tool, JSON.parse(wire));
        });

        it("validates a toolResult frame with output", () => {
            const frame: ServerFrame = {
                toolResult: {
                    name: "getCurrentTime",
                    output: "2026-09-20T00:00:00.000Z",
                },
            };
            expectWireConformant(
                () => serializeFrame(frame),
                MESSAGE_FOR_KEY.toolResult,
            );
        });

        it("validates a toolResult frame without output (JSON drops undefined)", () => {
            const wire = serializeFrame({
                toolResult: { name: "getCurrentTime", output: undefined },
            });
            expect(JSON.parse(wire).toolResult).not.toHaveProperty("output");
            expectSpecValid(MESSAGE_FOR_KEY.toolResult, JSON.parse(wire));
        });

        it("validates a done frame", () => {
            const frame: ServerFrame = { done: true };
            expectWireConformant(
                () => serializeFrame(frame),
                MESSAGE_FOR_KEY.done,
            );
        });

        it("validates an error frame (ws.ts wording)", () => {
            const frame: ServerFrame = {
                error: "another request is already in progress",
            };
            expectWireConformant(
                () => serializeFrame(frame),
                MESSAGE_FOR_KEY.error,
            );
        });

        it("validates an authResult frame (ws.test.ts exchange)", () => {
            const frame: ServerFrame = {
                authResult: { user: "luke", device: "macbook" },
            };
            expectWireConformant(
                () => serializeFrame(frame),
                MESSAGE_FOR_KEY.authResult,
            );
        });
    });

    describe("serializer round-trip", () => {
        it("every serializable server frame is spec-valid and parses", () => {
            const frames: ServerFrame[] = [
                { chunk: "" },
                { tool: { name: "a", args: {} } },
                { tool: { name: "a" } },
                { toolResult: { name: "a", output: {} } },
                { toolResult: { name: "a" } },
                { done: true },
                { error: "" },
                { authResult: { user: "u", device: "d" } },
            ];
            for (const frame of frames) {
                const text = serializeFrame(frame);
                const key = Object.keys(frame)[0];
                expectSpecValid(MESSAGE_FOR_KEY[key], JSON.parse(text));
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
// Negative: frames the protocol parser rejects, the spec must reject too
// ---------------------------------------------------------------------------

// Client-side frames parse through parseClientMessage; server-side through
// parseFrame. The helpers receive the client message names (server frames
// on `parseFrame` map through MESSAGE_FOR_KEY).
describe("AsyncAPI conformance: spec rejects protocol-invalid frames", () => {
    it("rejects a sessionId longer than MAX_SESSION_ID_LENGTH", () => {
        expectBothReject(
            MESSAGE_FOR_CLIENT.chatPrompt,
            asClient({ prompt: "hi", sessionId: "s".repeat(129) }),
            parseClientMessage,
        );
    });

    it("rejects a token longer than MAX_TOKEN_LENGTH", () => {
        expectBothReject(
            MESSAGE_FOR_CLIENT.authHandshake,
            asClient({ type: "auth", token: "t".repeat(129) }),
            parseClientMessage,
        );
    });

    it("rejects a whitespace-only sessionId (protocol trims, spec's \\S rejects)", () => {
        expectBothReject(
            MESSAGE_FOR_CLIENT.chatPrompt,
            asClient({ prompt: "hi", sessionId: "   " }),
            parseClientMessage,
        );
    });

    it("rejects a non-string chunk", () => {
        expectBothReject(
            MESSAGE_FOR_KEY.chunk,
            asFrame({ chunk: 5 }),
            parseFrame,
        );
    });

    it("rejects a done frame that is not exactly true", () => {
        expectBothReject(
            MESSAGE_FOR_KEY.done,
            asFrame({ done: "yes" }),
            parseFrame,
        );
    });

    it("rejects an authResult missing its device", () => {
        expectBothReject(
            MESSAGE_FOR_KEY.authResult,
            asFrame({ authResult: { user: "luke" } }),
            parseFrame,
        );
    });

    it("rejects a tool frame with a non-object payload", () => {
        expectBothReject(
            MESSAGE_FOR_KEY.tool,
            asFrame({ tool: "getCurrentTime" }),
            parseFrame,
        );
    });

    it("rejects an unknown frame shape entirely (no discriminator)", () => {
        expectBothReject(
            MESSAGE_FOR_KEY.error,
            asFrame({ surprise: true }),
            parseFrame,
        );
    });
});

// ---------------------------------------------------------------------------
// Spec strictness the protocol parser tolerates (pinned deliberately)
// ---------------------------------------------------------------------------

describe("AsyncAPI conformance: the spec is stricter than the parser", () => {
    it("rejects an empty object for every message (pins the required discriminator)", () => {
        // `additionalProperties: false` alone does not reject `{}` — this is
        // the one shape only the `required` lists catch.
        for (const key of SERVER_FRAME_KEYS) {
            expectBothReject(MESSAGE_FOR_KEY[key], asFrame({}), parseFrame);
        }
        for (const name of CLIENT_MESSAGE_NAMES) {
            expectBothReject(name, asClient({}), parseClientMessage);
        }
    });

    it("rejects an extra key on a chunk frame (parseFrame tolerates it)", () => {
        const wire = JSON.stringify({ chunk: "Hello", extra: 1 });
        expect(() => parseFrame(wire)).not.toThrow();
        expectSpecRejects(MESSAGE_FOR_KEY.chunk, { chunk: "Hello", extra: 1 });
    });

    it("rejects an extra key on a client chat prompt (parseClientMessage tolerates it)", () => {
        const wire = JSON.stringify({ prompt: "hi", sessionId: "s", extra: 1 });
        expect(() => parseClientMessage(wire)).not.toThrow();
        expectSpecRejects(MESSAGE_FOR_CLIENT.chatPrompt, {
            prompt: "hi",
            sessionId: "s",
            extra: 1,
        });
    });
});
