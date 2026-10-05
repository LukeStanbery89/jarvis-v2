import request from "supertest";
import {
    afterAll,
    beforeAll,
    afterEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { createApp } from "../src/app";
import { createAnalyzeImageTool } from "../src/llm/tools/analyzeImage";
import { createVisionModel } from "../src/llm/visionModel";
import { withAttachmentMarker } from "../src/agent";
import { createAttachmentStore } from "../src/attachments/store";
import {
    ByteLedger,
    InFlightLimiter,
    VlCallLimiter,
} from "../src/attachments/limiters";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AttachmentStore } from "../src/attachments/store";
import type { VisionModel } from "../src/llm/visionModel";
import type { AppConfig, AttachmentConfig } from "../src/config";
import { DEFAULT_ATTACHMENT_CONFIG } from "../src/config";
import { logger } from "../src/logger";
import type { Server } from "node:http";
import { createServer as createHttpServer } from "node:http";

/** A tiny valid PNG (1x1 pixel). */
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
);

const BOOTSTRAP = "s3cret-bootstrap";

const cfg = (over: Partial<AttachmentConfig> = {}): AttachmentConfig => ({
    ...DEFAULT_ATTACHMENT_CONFIG,
    ...over,
});

const appConfig = (
    attachments: AttachmentConfig,
    over: Partial<AppConfig> = {},
): AppConfig => ({
    appDbPath: ":memory:",
    turnTimeoutMs: 30_000,
    bootstrapToken: BOOTSTRAP,
    attachments,
    ...over,
});

/** Bootstraps an owner with `username` and returns a bearer token for it. */
async function bearerFor(
    app: ReturnType<typeof createApp>,
    username = "uploader",
): Promise<string> {
    await request(app)
        .post("/api/bootstrap")
        .set("x-bootstrap-token", BOOTSTRAP)
        .send({ username, password: "hunter2pw", deviceName: "test" });
    const res = await request(app)
        .post("/api/auth/login")
        .send({ username, password: "hunter2pw" });
    return res.body.device.token as string;
}

describe("POST /api/attachments", () => {
    const config = cfg();
    const store = createInMemoryAppDatabase();
    const attachments = createAttachmentStore(config);
    const inFlight = new InFlightLimiter(config.maxInflight);
    const app = createApp(store, appConfig(config), attachments, inFlight);

    afterAll(() => store.close());

    it("answers 401 without credentials", async () => {
        const res = await request(app)
            .post("/api/attachments")
            .send({ data: PNG.toString("base64") });
        expect(res.status).toBe(401);
    });

    it("accepts an image upload and returns an attachmentId", async () => {
        const token = await bearerFor(app);
        const res = await request(app)
            .post("/api/attachments")
            .set("Authorization", `Bearer ${token}`)
            .send({ data: PNG.toString("base64") });
        expect(res.status).toBe(201);
        expect(res.body.attachmentId).toHaveLength(24);
    });

    it("answers 413 with the AttachmentTooLarge shape when over the cap", async () => {
        const tiny = cfg({ maxBytes: 10 }); // PNG is 70 bytes
        const app = createApp(
            createInMemoryAppDatabase(),
            appConfig(tiny),
            createAttachmentStore(tiny),
            new InFlightLimiter(4),
        );
        const token = await bearerFor(app);
        const res = await request(app)
            .post("/api/attachments")
            .set("Authorization", `Bearer ${token}`)
            .send({ data: PNG.toString("base64") });
        expect(res.status).toBe(413);
        expect(res.body).toMatchObject({
            code: "ATTACHMENT_TOO_LARGE",
            maxBytes: 10,
        });
        expect(typeof res.body.error).toBe("string");
    });

    it("maps a parser-layer oversize body onto the same 413 shape", async () => {
        // maxBytes 10 → parser limit ≈ 65548; a 100 KB body trips the parser,
        // and the targeted handler (not the generic one) must answer.
        const tiny = cfg({ maxBytes: 10 });
        const app = createApp(
            createInMemoryAppDatabase(),
            appConfig(tiny),
            createAttachmentStore(tiny),
            new InFlightLimiter(4),
        );
        const token = await bearerFor(app);
        const res = await request(app)
            .post("/api/attachments")
            .set("Authorization", `Bearer ${token}`)
            .send({ data: "x".repeat(100 * 1024) });
        expect(res.status).toBe(413);
        expect(res.body).toMatchObject({
            code: "ATTACHMENT_TOO_LARGE",
            maxBytes: 10,
        });
    });

    it("answers 403 for non-image bytes (magic-byte sniff)", async () => {
        const fresh = createApp(
            createInMemoryAppDatabase(),
            appConfig(cfg()),
            createAttachmentStore(cfg()),
            new InFlightLimiter(4),
        );
        const token = await bearerFor(fresh, "sniffer");
        const res = await request(fresh)
            .post("/api/attachments")
            .set("Authorization", `Bearer ${token}`)
            .send({ data: Buffer.from("not an image").toString("base64") });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/not a recognized image/i);
    });

    it("answers 503 when the upload semaphore is saturated", async () => {
        const one = new InFlightLimiter(1);
        const app = createApp(
            createInMemoryAppDatabase(),
            appConfig(cfg()),
            createAttachmentStore(cfg()),
            one,
        );
        const token = await bearerFor(app, "saturated");
        const release = one.tryAcquire(); // hold the only slot
        const res = await request(app)
            .post("/api/attachments")
            .set("Authorization", `Bearer ${token}`)
            .send({ data: PNG.toString("base64") });
        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/too many uploads/i);
        release!();
    });

    it("rejects a cookie-authenticated upload without x-csrf-token", async () => {
        const login = await request(app).post("/api/session").send({
            username: "uploader",
            password: "hunter2pw",
        });
        const cookie = login.headers["set-cookie"][0].split(";")[0];
        const res = await request(app)
            .post("/api/attachments")
            .set("Cookie", cookie)
            .send({ data: PNG.toString("base64") });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/csrf/i);
    });
});

/** Fake attachments store scripted per test. */
function fakeStore(over: Partial<AttachmentStore> = {}): AttachmentStore {
    return {
        put: vi.fn(async () => "fake-id"),
        get: vi.fn(async () => PNG),
        assertAccessible: vi.fn(),
        release: vi.fn(),
        sweep: vi.fn(async () => 0),
        heldBytes: vi.fn(() => 0),
        ...over,
    };
}

/** Fake VL model capturing the last call. */
function fakeVision(answer = "a blue square"): {
    vision: VisionModel;
    calls: { dataUrl: string; query: string }[];
} {
    const calls: { dataUrl: string; query: string }[] = [];
    return {
        calls,
        vision: {
            analyze: vi.fn(async (dataUrl: string, query: string) => {
                calls.push({ dataUrl, query });
                return answer;
            }),
        },
    };
}

describe("analyzeImage tool", () => {
    const OWNER = 7;

    /** Runs the tool with configurable fakes; returns the tool's text result. */
    async function run(
        over: {
            store?: Partial<AttachmentStore>;
            limiter?: VlCallLimiter;
        } = {},
        query = "What is in this image?",
    ): Promise<{ result: string; vision: ReturnType<typeof fakeVision> }> {
        const store = fakeStore(over.store);
        const fv = fakeVision();
        const limiter = over.limiter ?? new VlCallLimiter(10);
        const tool = createAnalyzeImageTool({
            attachments: store,
            vision: fv.vision,
            vlLimiter: limiter,
        });
        const result = await tool.invoke(
            { attachmentId: "q83hZxLm5sVvT1yKwB9dE2nA", query },
            { configurable: { attachmentOwner: OWNER } },
        );
        return { result: result as string, vision: fv };
    }

    it("passes the query through verbatim and returns the analysis", async () => {
        const { result, vision } = await run({}, "Describe the chart");
        expect(result).toBe("a blue square");
        expect(vision.calls[0].query).toBe("Describe the chart");
    });

    it("builds a sniffed-mime data URL from the stored bytes", async () => {
        const { vision } = await run();
        expect(vision.calls[0].dataUrl).toMatch(/^data:image\/png;base64,/);
    });

    it("refuses without an authenticated owner (defense in depth)", async () => {
        const store = fakeStore();
        const fv = fakeVision();
        const tool = createAnalyzeImageTool({
            attachments: store,
            vision: fv.vision,
            vlLimiter: new VlCallLimiter(10),
        });
        const result = (await tool.invoke(
            { attachmentId: "abc", query: "q" },
            {}, // no configurable — a mis-wired graph
        )) as string;
        expect(result).toMatch(/requires signing in/i);
        expect(fv.vision.analyze).not.toHaveBeenCalled();
    });

    it.each(["unknown", "expired", "foreign"] as const)(
        "maps the %s error kind to user-safe text without calling the model",
        async (kind) => {
            const store = fakeStore({
                get: vi.fn(async () => {
                    throw new (class extends Error {
                        constructor(
                            public code: string,
                            message: string,
                        ) {
                            super(message);
                        }
                    })(kind, kind);
                }),
            });
            const fv = fakeVision();
            const tool = createAnalyzeImageTool({
                attachments: store,
                vision: fv.vision,
                vlLimiter: new VlCallLimiter(10),
            });
            const result = (await tool.invoke(
                { attachmentId: "abc", query: "q" },
                { configurable: { attachmentOwner: OWNER } },
            )) as string;
            expect(result).toMatch(/image/i);
            expect(fv.vision.analyze).not.toHaveBeenCalled();
        },
    );

    it("relays the VL limiter refusal as retry timing, not an error", async () => {
        const limiter = new VlCallLimiter(0); // nothing admitted
        const { result, vision } = await run({ limiter });
        expect(result).toMatch(/rate limited/i);
        expect(vision.vision.analyze).not.toHaveBeenCalled();
    });

    it("never logs attachment bytes or base64 payloads", async () => {
        const sensitive = vi.spyOn(logger, "sensitive");
        const sensitiveDebug = vi.spyOn(logger, "sensitiveDebug");
        await run();
        for (const spy of [sensitive, sensitiveDebug]) {
            for (const call of spy.mock.calls) {
                expect(JSON.stringify(call)).not.toContain(
                    PNG.toString("base64").slice(0, 20),
                );
            }
        }
        sensitive.mockRestore();
        sensitiveDebug.mockRestore();
    });
});

describe("withAttachmentMarker", () => {
    it("appends a deduplicated id list", () => {
        expect(withAttachmentMarker("look", ["a", "b", "a", ""])).toBe(
            "look\n\n[attachments: a, b]",
        );
    });

    it("leaves a plain prompt byte-identical", () => {
        expect(withAttachmentMarker("hello", [])).toBe("hello");
    });
});

describe("createVisionModel", () => {
    // A hang server: accepts connections, never answers — proving the
    // AbortSignal.timeout bound fires (review finding R4).
    let server: Server;
    let baseUrl: string;
    beforeAll(async () => {
        server = createHttpServer(() => {
            /* hang */
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", () => resolve()),
        );
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}/v1`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("aborts an analysis that outlives LLM_VL_TIMEOUT_MS", async () => {
        const vision = createVisionModel({
            baseUrl,
            model: "test",
            temperature: 0,
            streamUsage: false,
            systemPrompt: "",
            agentMaxTurns: 1,
            checkpointPath: ":memory:",
            vlModel: "test-vl",
            vlMaxTokens: 16,
            vlTimeoutMs: 100,
        });
        const started = Date.now();
        await expect(
            vision.analyze(
                `data:image/png;base64,${PNG.toString("base64")}`,
                "q",
            ),
        ).rejects.toThrow(/abort/i);
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("keeps reasoning content out of the answer", async () => {
        // A local mock OpenAI-compatible endpoint returning a reasoning_model
        // style payload with both reasoning_content and content.
        server.close();
        let seenBody: string | null = null;
        server = createHttpServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                seenBody = body;
                res.setHeader("Content-Type", "application/json");
                res.end(
                    JSON.stringify({
                        choices: [
                            {
                                message: {
                                    role: "assistant",
                                    content: "  the answer  ",
                                    reasoning_content: "thinking hard…",
                                },
                            },
                        ],
                    }),
                );
            });
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", () => resolve()),
        );
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const vision = createVisionModel({
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "test",
            temperature: 0,
            streamUsage: false,
            systemPrompt: "",
            agentMaxTurns: 1,
            checkpointPath: ":memory:",
            vlModel: "test-vl",
            vlMaxTokens: 16,
            vlTimeoutMs: 5_000,
        });
        const answer = await vision.analyze(
            `data:image/png;base64,${PNG.toString("base64")}`,
            "q",
        );
        expect(answer).toBe("the answer");
        expect(seenBody).not.toBeNull();
        // The ask reached the wire as a multimodal message.
        expect(seenBody!).toContain("image_url");
    });
});
