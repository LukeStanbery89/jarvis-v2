/**
 * Sandbox configuration tests (#141).
 *
 * The block's absence is as load-bearing as its contents: `JARVIS_SANDBOX`
 * unset must leave `AppConfig.sandbox` undefined, so a deployment with no
 * container runtime cannot advertise a coding-job surface. The rest is the
 * usual environment round-trip, including the two values that exist because
 * the daemon and the server see different filesystems.
 */
import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import {
    DEFAULT_SANDBOX_CONFIG,
    defaultSandboxWorkspaceRoot,
    getAppConfig,
} from "../src/config";

const SANDBOX_VARS = [
    "JARVIS_SANDBOX",
    "JARVIS_SANDBOX_IMAGE",
    "JARVIS_SANDBOX_DOCKER_SOCKET",
    "JARVIS_SANDBOX_WORKSPACE_ROOT",
    "JARVIS_SANDBOX_WORKSPACE_HOST_ROOT",
    "JARVIS_SANDBOX_MAX_JOBS",
    "JARVIS_SANDBOX_CPUS",
    "JARVIS_SANDBOX_MEMORY_MB",
    "JARVIS_SANDBOX_PIDS",
    "JARVIS_SANDBOX_WALL_CLOCK_MINUTES",
    "JARVIS_SANDBOX_REPOS",
    "JARVIS_SANDBOX_MODEL",
    "JARVIS_SANDBOX_EXTRA_HOSTS",
];

afterEach(() => {
    for (const key of SANDBOX_VARS) {
        delete process.env[key];
    }
});

describe("sandbox config", () => {
    it("is absent unless the deployment opts in", () => {
        expect(getAppConfig().sandbox).toBeUndefined();

        // Only `docker` is implemented; anything else must not conjure a
        // surface that cannot run a job.
        process.env.JARVIS_SANDBOX = "off";
        expect(getAppConfig().sandbox).toBeUndefined();
    });

    it("fills a laptop-safe default when enabled", () => {
        process.env.JARVIS_SANDBOX = "docker";

        const sandbox = getAppConfig().sandbox;
        expect(sandbox).toEqual({
            image: DEFAULT_SANDBOX_CONFIG.image,
            socketPath: DEFAULT_SANDBOX_CONFIG.socketPath,
            workspaceRoot: defaultSandboxWorkspaceRoot(),
            workspaceHostRoot: defaultSandboxWorkspaceRoot(),
            maxJobs: 1,
            cpus: 2,
            memoryMb: 4096,
            pids: 512,
            wallClockMs: 45 * 60 * 1000,
            repos: [],
            model: "big-pickle",
            llmBaseUrl: "https://opencode.ai/inference/openai/v1",
            apiKey: "",
            extraHosts: ["host.docker.internal:host-gateway"],
        });
        // One default home for the workspace tree, beside the database.
        expect(defaultSandboxWorkspaceRoot()).toBe(
            path.join(homedir(), ".jarvis", "jobs"),
        );
    });

    it("reads every knob", () => {
        process.env.JARVIS_SANDBOX = "docker";
        process.env.JARVIS_SANDBOX_IMAGE = "jarvis-job:dev";
        process.env.JARVIS_SANDBOX_DOCKER_SOCKET = "/run/custom.sock";
        process.env.JARVIS_SANDBOX_WORKSPACE_ROOT = "/srv/jobs";
        process.env.JARVIS_SANDBOX_WORKSPACE_HOST_ROOT = "/host/jobs";
        process.env.JARVIS_SANDBOX_MAX_JOBS = "3";
        process.env.JARVIS_SANDBOX_CPUS = "4";
        process.env.JARVIS_SANDBOX_MEMORY_MB = "8192";
        process.env.JARVIS_SANDBOX_PIDS = "256";
        process.env.JARVIS_SANDBOX_WALL_CLOCK_MINUTES = "10";
        process.env.JARVIS_SANDBOX_REPOS = "luke/app, other/repo ";
        process.env.JARVIS_SANDBOX_MODEL = "lmstudio/qwen3";
        process.env.JARVIS_SANDBOX_LLM_BASE_URL = "http://model.lan:1234/v1";
        process.env.JARVIS_SANDBOX_API_KEY = "sk-test";
        process.env.JARVIS_SANDBOX_EXTRA_HOSTS = "db:172.18.0.2";

        const sandbox = getAppConfig().sandbox;
        expect(sandbox).toMatchObject({
            image: "jarvis-job:dev",
            socketPath: "/run/custom.sock",
            workspaceRoot: "/srv/jobs",
            workspaceHostRoot: "/host/jobs",
            maxJobs: 3,
            cpus: 4,
            memoryMb: 8192,
            pids: 256,
            wallClockMs: 10 * 60 * 1000,
            repos: ["luke/app", "other/repo"],
            model: "lmstudio/qwen3",
            llmBaseUrl: "http://model.lan:1234/v1",
            apiKey: "sk-test",
            extraHosts: ["db:172.18.0.2"],
        });
    });

    it("lets an operator turn the host alias off", () => {
        process.env.JARVIS_SANDBOX = "docker";
        process.env.JARVIS_SANDBOX_EXTRA_HOSTS = " none ";

        expect(getAppConfig().sandbox?.extraHosts).toEqual([]);
    });

    it("falls back on a nonsensical number rather than failing the boot", () => {
        process.env.JARVIS_SANDBOX = "docker";
        process.env.JARVIS_SANDBOX_CPUS = "many";

        expect(getAppConfig().sandbox?.cpus).toBe(2);
    });
});
