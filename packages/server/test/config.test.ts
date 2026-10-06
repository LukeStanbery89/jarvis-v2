import { afterEach, describe, expect, it } from "vitest";
import {
    DEFAULT_HA_CACHE_TTL_MS,
    DEFAULT_HA_CALLS_PER_MIN,
    DEFAULT_HA_CONTROL_DOMAINS,
    DEFAULT_HA_LIST_LIMIT,
    DEFAULT_HA_READ_DOMAINS,
    DEFAULT_HA_TIMEOUT_MS,
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_RATE_LIMIT_CONFIG,
    DEFAULT_TURN_TIMEOUT_MS,
    DEFAULT_WEATHER_CALLS_PER_MIN,
    DEFAULT_WEATHER_TIMEOUT_MS,
    defaultAppDbPath,
    defaultPortalDir,
    defaultWebDir,
    getAppConfig,
    getServerPort,
} from "../src/config";
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
    delete process.env.JARVIS_API_CONTRACT;
    delete process.env.JARVIS_PORTAL_DIR;
    delete process.env.JARVIS_WEB_DIR;
    delete process.env.JARVIS_CORS_ORIGINS;
    delete process.env.JARVIS_TRUST_PROXY_CIDRS;
    delete process.env.TAVILY_API_KEY;
    delete process.env.SERPER_API_KEY;
    delete process.env.JARVIS_SEARCH_TIMEOUT_MS;
    delete process.env.JARVIS_SEARCH_MAX_RESULTS;
    delete process.env.JARVIS_SEARCH_CALLS_PER_MIN;
    delete process.env.OPENWEATHER_API_KEY;
    delete process.env.JARVIS_WEATHER_UNITS;
    delete process.env.JARVIS_WEATHER_TIMEOUT_MS;
    delete process.env.JARVIS_WEATHER_CALLS_PER_MIN;
    delete process.env.HOME_ASSISTANT_URL;
    delete process.env.HOME_ASSISTANT_ACCESS_TOKEN;
    delete process.env.JARVIS_HA_READ_DOMAINS;
    delete process.env.JARVIS_HA_CONTROL_DOMAINS;
    delete process.env.JARVIS_HA_CALLS_PER_MIN;
    delete process.env.JARVIS_HA_TIMEOUT_MS;
    delete process.env.JARVIS_HA_CACHE_TTL_MS;
    delete process.env.JARVIS_HA_LIST_LIMIT;
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

    it("verifies REST responses only under JARVIS_API_CONTRACT=verify", () => {
        expect(getAppConfig().apiContractVerify).toBe(false);
        process.env.JARVIS_API_CONTRACT = "verify";
        expect(getAppConfig().apiContractVerify).toBe(true);
        process.env.JARVIS_API_CONTRACT = "off";
        expect(getAppConfig().apiContractVerify).toBe(false);
    });

    it("resolves the portal and web dirs from the workspace by default", () => {
        expect(getAppConfig().portalDir).toBe(defaultPortalDir());
        expect(getAppConfig().webDir).toBe(defaultWebDir());
        expect(defaultWebDir()).toMatch(/packages\/web\/dist$/);
    });

    it("reads JARVIS_PORTAL_DIR and JARVIS_WEB_DIR; empty string disables", () => {
        process.env.JARVIS_PORTAL_DIR = "/srv/portal";
        process.env.JARVIS_WEB_DIR = "/srv/web";
        expect(getAppConfig()).toMatchObject({
            portalDir: "/srv/portal",
            webDir: "/srv/web",
        });
        process.env.JARVIS_PORTAL_DIR = "";
        process.env.JARVIS_WEB_DIR = "";
        expect(getAppConfig()).toMatchObject({
            portalDir: undefined,
            webDir: undefined,
        });
    });
});

describe("cross-origin configuration (#63)", () => {
    it("denies all cross-origin requests when JARVIS_CORS_ORIGINS is unset", () => {
        delete process.env.JARVIS_CORS_ORIGINS;
        expect(getAppConfig().corsOrigins).toBeUndefined();
    });

    it("treats a blank or comma-only list as no configured origins", () => {
        process.env.JARVIS_CORS_ORIGINS = "";
        expect(getAppConfig().corsOrigins).toEqual([]);
        process.env.JARVIS_CORS_ORIGINS = " , , ";
        expect(getAppConfig().corsOrigins).toEqual([]);
    });

    it("parses a comma-separated allowlist, trimming whitespace", () => {
        process.env.JARVIS_CORS_ORIGINS =
            "https://desk.example.com, http://laptop.local:5173 ";
        expect(getAppConfig().corsOrigins).toEqual([
            "https://desk.example.com",
            "http://laptop.local:5173",
        ]);
    });

    it("normalizes an origin to the form a browser sends", () => {
        // A trailing slash or mixed case in the operator's config must still
        // match `Origin: http://Laptop.local:5173`.
        process.env.JARVIS_CORS_ORIGINS =
            "http://Laptop.local:5173/,https://Desk.Example.COM";
        expect(getAppConfig().corsOrigins).toEqual([
            "http://laptop.local:5173",
            "https://desk.example.com",
        ]);
    });

    it("keeps a non-default port and the scheme intact", () => {
        process.env.JARVIS_CORS_ORIGINS = "http://192.168.1.10:8080";
        expect(getAppConfig().corsOrigins).toEqual([
            "http://192.168.1.10:8080",
        ]);
    });

    it("trusts no proxies when JARVIS_TRUST_PROXY_CIDRS is unset", () => {
        delete process.env.JARVIS_TRUST_PROXY_CIDRS;
        expect(getAppConfig().trustProxyCidrs).toBeUndefined();
        process.env.JARVIS_TRUST_PROXY_CIDRS = "  ";
        expect(getAppConfig().trustProxyCidrs).toEqual([]);
    });

    it("omits search config when no provider key is set (#9)", () => {
        expect(getAppConfig().search).toBeUndefined();
        process.env.SERPER_API_KEY = "";
        expect(getAppConfig().search).toBeUndefined();
    });

    it("parses search config when either provider key is set (#9)", () => {
        process.env.TAVILY_API_KEY = "tvly-test";
        expect(getAppConfig().search).toMatchObject({
            tavilyApiKey: "tvly-test",
            serperApiKey: undefined,
        });
        process.env.SERPER_API_KEY = "serper-test";
        process.env.JARVIS_SEARCH_TIMEOUT_MS = "5000";
        process.env.JARVIS_SEARCH_MAX_RESULTS = "3";
        process.env.JARVIS_SEARCH_CALLS_PER_MIN = "7";
        expect(getAppConfig().search).toEqual({
            tavilyApiKey: "tvly-test",
            serperApiKey: "serper-test",
            timeoutMs: 5000,
            maxResults: 3,
            callsPerMin: 7,
        });
    });

    it("omits weather config when no OpenWeather key is set (#31)", () => {
        expect(getAppConfig().weather).toBeUndefined();
        process.env.OPENWEATHER_API_KEY = "";
        expect(getAppConfig().weather).toBeUndefined();
    });

    it("parses weather config when the OpenWeather key is set (#31)", () => {
        process.env.OPENWEATHER_API_KEY = "ow-test";
        expect(getAppConfig().weather).toEqual({
            apiKey: "ow-test",
            units: "imperial",
            timeoutMs: DEFAULT_WEATHER_TIMEOUT_MS,
            callsPerMin: DEFAULT_WEATHER_CALLS_PER_MIN,
        });
        process.env.JARVIS_WEATHER_UNITS = "metric";
        process.env.JARVIS_WEATHER_TIMEOUT_MS = "5000";
        process.env.JARVIS_WEATHER_CALLS_PER_MIN = "7";
        expect(getAppConfig().weather).toEqual({
            apiKey: "ow-test",
            units: "metric",
            timeoutMs: 5000,
            callsPerMin: 7,
        });
    });

    it("falls back to the default weather unit on an unknown value (#31)", () => {
        process.env.OPENWEATHER_API_KEY = "ow-test";
        process.env.JARVIS_WEATHER_UNITS = "kelvin";
        expect(getAppConfig().weather?.units).toBe("imperial");
    });

    it("omits home assistant config unless the URL and token are both set (#15)", () => {
        expect(getAppConfig().homeAssistant).toBeUndefined();
        process.env.HOME_ASSISTANT_URL = "http://ha.local:8123";
        expect(getAppConfig().homeAssistant).toBeUndefined();
        delete process.env.HOME_ASSISTANT_URL;
        process.env.HOME_ASSISTANT_ACCESS_TOKEN = "ha-token";
        expect(getAppConfig().homeAssistant).toBeUndefined();
        process.env.HOME_ASSISTANT_URL = "http://ha.local:8123";
        process.env.HOME_ASSISTANT_ACCESS_TOKEN = "";
        expect(getAppConfig().homeAssistant).toBeUndefined();
    });

    it("parses home assistant config with every default (#15)", () => {
        process.env.HOME_ASSISTANT_URL = "http://ha.local:8123/";
        process.env.HOME_ASSISTANT_ACCESS_TOKEN = "ha-token";
        expect(getAppConfig().homeAssistant).toEqual({
            // The trailing slash is stripped so path joins never double up.
            url: "http://ha.local:8123",
            accessToken: "ha-token",
            readDomains: [...DEFAULT_HA_READ_DOMAINS],
            controlDomains: [...DEFAULT_HA_CONTROL_DOMAINS],
            callsPerMin: DEFAULT_HA_CALLS_PER_MIN,
            timeoutMs: DEFAULT_HA_TIMEOUT_MS,
            cacheTtlMs: DEFAULT_HA_CACHE_TTL_MS,
            listLimit: DEFAULT_HA_LIST_LIMIT,
        });
    });

    it("reads are broader than the controllable domains (#15)", () => {
        const every = DEFAULT_HA_READ_DOMAINS.filter(
            (domain) => !DEFAULT_HA_CONTROL_DOMAINS.includes(domain),
        );
        expect(every).toContain("lock");
        expect(every).toContain("cover");
        expect(every).not.toContain("light");
    });

    it("overrides every home assistant knob (#15)", () => {
        process.env.HOME_ASSISTANT_URL = "https://ha.example.com";
        process.env.HOME_ASSISTANT_ACCESS_TOKEN = "ha-token";
        process.env.JARVIS_HA_READ_DOMAINS = "light, sensor";
        process.env.JARVIS_HA_CONTROL_DOMAINS = "light";
        process.env.JARVIS_HA_CALLS_PER_MIN = "3";
        process.env.JARVIS_HA_TIMEOUT_MS = "2500";
        process.env.JARVIS_HA_CACHE_TTL_MS = "0";
        process.env.JARVIS_HA_LIST_LIMIT = "5";
        expect(getAppConfig().homeAssistant).toEqual({
            url: "https://ha.example.com",
            accessToken: "ha-token",
            readDomains: ["light", "sensor"],
            controlDomains: ["light"],
            callsPerMin: 3,
            timeoutMs: 2500,
            cacheTtlMs: 0,
            listLimit: 5,
        });
    });

    it("falls back to the defaults for an unparsable override (#15)", () => {
        process.env.HOME_ASSISTANT_URL = "http://ha.local:8123";
        process.env.HOME_ASSISTANT_ACCESS_TOKEN = "ha-token";
        process.env.JARVIS_HA_CALLS_PER_MIN = "lots";
        process.env.JARVIS_HA_TIMEOUT_MS = "-1";
        process.env.JARVIS_HA_CACHE_TTL_MS = "forever";
        process.env.JARVIS_HA_LIST_LIMIT = "";
        const config = getAppConfig().homeAssistant;
        expect(config?.callsPerMin).toBe(DEFAULT_HA_CALLS_PER_MIN);
        expect(config?.timeoutMs).toBe(DEFAULT_HA_TIMEOUT_MS);
        expect(config?.cacheTtlMs).toBe(DEFAULT_HA_CACHE_TTL_MS);
        expect(config?.listLimit).toBe(DEFAULT_HA_LIST_LIMIT);
    });

    it("parses trusted proxies as IPs and subnets", () => {
        process.env.JARVIS_TRUST_PROXY_CIDRS =
            "172.16.0.0/12, 10.0.0.5 , 192.168.0.0/16";
        expect(getAppConfig().trustProxyCidrs).toEqual([
            "172.16.0.0/12",
            "10.0.0.5",
            "192.168.0.0/16",
        ]);
    });
});
