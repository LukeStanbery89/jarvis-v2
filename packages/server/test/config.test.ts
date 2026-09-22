import { afterEach, describe, expect, it } from "vitest";
import {
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_TURN_TIMEOUT_MS,
    defaultAppDbPath,
    getAppConfig,
    getServerPort,
} from "../src/config";
import { DEFAULT_RATE_LIMIT_CONFIG } from "../src/http/rateLimit";
import { homedir } from "node:os";

afterEach(() => {
    delete process.env.PORT;
    delete process.env.JARVIS_DB_PATH;
    delete process.env.JARVIS_TURN_TIMEOUT_MS;
    delete process.env.JARVIS_BOOTSTRAP_TOKEN;
    delete process.env.JARVIS_HOST;
    delete process.env.JARVIS_TLS_CERT;
    delete process.env.JARVIS_TLS_KEY;
    delete process.env.JARVIS_RATE_WINDOW_MS;
    delete process.env.JARVIS_RATE_MAX_FAILURES;
    delete process.env.JARVIS_RATE_LOCKOUT_MS;
    delete process.env.JARVIS_RATE_MAX_IP_FAILURES;
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

    it("defaults host to all interfaces and reads JARVIS_HOST", () => {
        expect(getAppConfig().host).toBe(DEFAULT_HOST);
        process.env.JARVIS_HOST = "127.0.0.1";
        expect(getAppConfig().host).toBe("127.0.0.1");
    });

    it("reads TLS cert/key paths (TLS off by default)", () => {
        expect(getAppConfig()).toMatchObject({
            tlsCertPath: undefined,
            tlsKeyPath: undefined,
        });
        process.env.JARVIS_TLS_CERT = "/run/jarvis/fullchain.pem";
        process.env.JARVIS_TLS_KEY = "/run/jarvis/privkey.pem";
        expect(getAppConfig()).toMatchObject({
            tlsCertPath: "/run/jarvis/fullchain.pem",
            tlsKeyPath: "/run/jarvis/privkey.pem",
        });
    });

    it("reads rate-limit knobs and defaults to LAN values", () => {
        expect(getAppConfig().loginRateLimit).toEqual(
            DEFAULT_RATE_LIMIT_CONFIG,
        );
        process.env.JARVIS_RATE_MAX_FAILURES = "5";
        process.env.JARVIS_RATE_LOCKOUT_MS = "1000";
        expect(getAppConfig().loginRateLimit).toMatchObject({
            maxFailures: 5,
            lockoutMs: 1000,
            windowMs: DEFAULT_RATE_LIMIT_CONFIG.windowMs,
        });
    });
});
