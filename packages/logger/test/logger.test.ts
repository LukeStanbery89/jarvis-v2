import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/index";
import type { LogLevel } from "../src/index";

afterEach(() => {
    delete process.env.JARVIS_LOG_LEVEL;
    delete process.env.JARVIS_LOG_SENSITIVE;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
});

/** Collects writes into an array so tests can assert on the exact lines. */
function makeCapture(): { stream: Writable; lines: () => string[] } {
    const lines: string[] = [];
    const stream = new Writable({
        write(chunk, _encoding, callback) {
            lines.push(chunk.toString());
            callback();
        },
    });
    return { stream, lines: () => lines };
}

/** Runs `fn` with `level` set for JARVIS_LOG_LEVEL, restoring it afterwards. */
function withEnvLevel(level: LogLevel, fn: () => void): void {
    process.env.JARVIS_LOG_LEVEL = level;
    fn();
}

describe("createLogger", () => {
    it("defaults to the info level and hides debug messages", () => {
        const { stream, lines } = makeCapture();
        const logger = createLogger({ tag: "server", stream });

        logger.debug("not printed");
        logger.info("printed");

        expect(lines()).toHaveLength(1);
        expect(lines()[0]).toContain("printed");
        expect(lines()[0]).not.toContain("not printed");
    });

    it("enables debug messages when JARVIS_LOG_LEVEL is debug", () => {
        const { stream, lines } = makeCapture();
        withEnvLevel("debug", () => {
            const logger = createLogger({ tag: "server", stream });
            logger.debug("trace detail");
        });

        expect(lines()[0]).toContain("trace detail");
    });

    it("drops info and debug at the warn level", () => {
        const { stream, lines } = makeCapture();
        withEnvLevel("warn", () => {
            const logger = createLogger({ tag: "server", stream });
            logger.info("hidden");
            logger.warn("shown");
            logger.error("bad things");
        });

        const joined = lines().join("\n");
        expect(joined).toContain("shown");
        expect(joined).toContain("bad things");
        expect(joined).not.toContain("hidden");
    });

    it("lets an explicit level override the environment", () => {
        const { stream, lines } = makeCapture();
        withEnvLevel("debug", () => {
            const logger = createLogger({
                tag: "server",
                stream,
                level: "warn",
            });
            logger.debug("not shown");
            logger.warn("shown");
            expect(logger.level).toBe("warn");
        });

        const joined = lines().join("\n");
        expect(joined).toContain("shown");
        expect(joined).not.toContain("not shown");
    });

    it("prints a timestamp and a level label on every line", () => {
        const { stream, lines } = makeCapture();
        const logger = createLogger({ tag: "server", stream, level: "debug" });

        logger.debug("debug msg");
        logger.info("info msg");
        logger.error("error msg");

        expect(lines()).toHaveLength(3);
        expect(lines()[0]).toMatch(
            /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[DEBUG\]/,
        );
        expect(lines()[1]).toMatch(/\[INFO\]/);
        expect(lines()[2]).toMatch(/\[ERROR\]/);
    });

    it("attributes every line to the configured tag", () => {
        const { stream, lines } = makeCapture();
        const logger = createLogger({ tag: "cli", stream });
        logger.info("hello");

        expect(lines()[0]).toMatch(/\[INFO\] cli — hello\n$/);
    });

    it("colorizes the level label when color is true", () => {
        const { stream, lines } = makeCapture();
        const logger = createLogger({ tag: "server", stream, color: true });
        logger.info("hello");

        expect(lines()[0]).toContain("\u001b[32mINFO\u001b[0m");
    });

    it("disables colors when NO_COLOR is set", () => {
        const { stream, lines } = makeCapture();
        process.env.NO_COLOR = "1";
        const logger = createLogger({ tag: "server", stream });
        logger.info("hello");

        expect(lines()[0]).not.toContain("\u001b[");
    });

    it("formats Errors as their message and objects as JSON", () => {
        const { stream, lines } = makeCapture();
        const logger = createLogger({ tag: "server", stream });

        logger.error(new Error("boom"));
        logger.info({ requestId: 42 });

        const joined = lines().join("\n");
        expect(joined).toContain("— boom");
        expect(joined).toContain('{"requestId":42}');
    });
});

describe("sensitive logging", () => {
    it("defaults to redacted so payloads never leak", () => {
        const { stream, lines } = makeCapture();
        const logger = createLogger({ tag: "server", stream });

        logger.sensitive("Streaming LLM response", "hello there");
        logger.sensitive("New message");

        expect(logger.sensitiveMode).toBe("redacted");
        expect(lines()[0]).toMatch(
            /\d{2}:\d{2}:\d{2} \[INFO\] server — Streaming LLM response: \[REDACTED\]\n/,
        );
        expect(lines()[1]).toMatch(/\[INFO\] server — New message\n$/);
        expect(lines().join("\n")).not.toContain("hello there");
    });

    it("renders payloads in full mode", () => {
        const { stream, lines } = makeCapture();
        const logger = createLogger({
            tag: "server",
            stream,
            sensitive: "full",
        });

        logger.sensitive("Streaming LLM response", { prompt: "hi" });

        expect(logger.sensitiveMode).toBe("full");
        expect(lines()[0]).toContain('Streaming LLM response: {"prompt":"hi"}');
    });

    it("enables full mode when NODE_ENV is development", () => {
        const saved = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = "development";
            const { stream, lines } = makeCapture();
            const logger = createLogger({ tag: "server", stream });
            logger.sensitive("Streaming LLM response", "dev prompt");
            expect(logger.sensitiveMode).toBe("full");
            expect(lines()[0]).toContain("dev prompt");
        } finally {
            if (saved === undefined) {
                delete process.env.NODE_ENV;
            } else {
                process.env.NODE_ENV = saved;
            }
        }
    });

    it("honours the JARVIS_LOG_SENSITIVE env var", () => {
        process.env.JARVIS_LOG_SENSITIVE = "full";
        const { stream, lines } = makeCapture();
        const logger = createLogger({ tag: "server", stream });
        logger.sensitive("Streaming LLM response", "from env");
        expect(logger.sensitiveMode).toBe("full");
        expect(lines()[0]).toContain("from env");
    });

    it("lets an explicit option override the environment", () => {
        process.env.JARVIS_LOG_SENSITIVE = "full";
        const { stream, lines } = makeCapture();
        const logger = createLogger({
            tag: "server",
            stream,
            sensitive: "redacted",
        });
        logger.sensitive("Streaming LLM response", "secret");
        expect(logger.sensitiveMode).toBe("redacted");
        expect(lines()[0]).toContain("[REDACTED]");
    });

    it("emits sensitiveDebug only in full mode", () => {
        const fullCapture = makeCapture();
        const redactedCapture = makeCapture();
        const full = createLogger({
            tag: "server",
            stream: fullCapture.stream,
            sensitive: "full",
            level: "debug",
        });
        const redacted = createLogger({
            tag: "server",
            stream: redactedCapture.stream,
            level: "debug",
        });

        full.sensitiveDebug("LLM token", "Hello");
        full.info("noop");
        redacted.sensitiveDebug("LLM token", "Spoiler");
        redacted.info("redacted visible");

        expect(fullCapture.lines().join("\n")).toContain("LLM token: Hello");
        const redactedJoined = redactedCapture.lines().join("\n");
        expect(redactedJoined).toContain("redacted visible");
        expect(redactedJoined).not.toContain("Spoiler");
    });
});
