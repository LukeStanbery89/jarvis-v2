import { afterEach, describe, expect, it } from "vitest";
import {
    DEFAULT_PORT,
    DEFAULT_TURN_TIMEOUT_MS,
    defaultAppDbPath,
    getAppConfig,
    getServerPort,
} from "../src/config";
import { homedir } from "node:os";

afterEach(() => {
    delete process.env.PORT;
    delete process.env.JARVIS_DB_PATH;
    delete process.env.JARVIS_TURN_TIMEOUT_MS;
    delete process.env.JARVIS_BOOTSTRAP_TOKEN;
});

describe("getServerPort", () => {
    it("defaults to the served port", () => {
        delete process.env.PORT;
        expect(getServerPort()).toBe(DEFAULT_PORT);
    });

    it("reads PORT", () => {
        process.env.PORT = "8080";
        expect(getServerPort()).toBe(8080);
    });

    it("is overridable with 0 (ephemeral bind)", () => {
        process.env.PORT = "0";
        expect(getServerPort()).toBe(0);
    });
});

describe("getAppConfig", () => {
    it("defaults the app db path into ~/.jarvis", () => {
        expect(defaultAppDbPath()).toBe(`${homedir()}/.jarvis/jarvis.sqlite`);
    });

    it("reads JARVIS_DB_PATH and JARVIS_TURN_TIMEOUT_MS", () => {
        process.env.JARVIS_DB_PATH = "/tmp/app.sqlite";
        process.env.JARVIS_TURN_TIMEOUT_MS = "30000";
        expect(getAppConfig()).toMatchObject({
            appDbPath: "/tmp/app.sqlite",
            turnTimeoutMs: 30000,
        });
    });

    it("defaults the turn timeout and leaves bootstrap disabled", () => {
        expect(getAppConfig()).toMatchObject({
            turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
            bootstrapToken: undefined,
        });
    });

    it("reads JARVIS_BOOTSTRAP_TOKEN", () => {
        process.env.JARVIS_BOOTSTRAP_TOKEN = "setup-secret";
        expect(getAppConfig().bootstrapToken).toBe("setup-secret");
    });
});
