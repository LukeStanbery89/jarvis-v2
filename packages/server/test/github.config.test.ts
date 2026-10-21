/**
 * GitHub App configuration (#140).
 *
 * The integration's posture is the interesting part: a partially configured
 * App is *off*, not a boot failure, because the sandbox still works when a
 * branch stays local.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGitHubConfig } from "../src/config";

const VARS = [
    "JARVIS_GITHUB_APP_ID",
    "JARVIS_GITHUB_APP_PRIVATE_KEY",
    "JARVIS_GITHUB_APP_PRIVATE_KEY_PATH",
    "JARVIS_GITHUB_INSTALLATION_ID",
    "JARVIS_GITHUB_API_BASE_URL",
    "JARVIS_GITHUB_REPOS",
    "JARVIS_SANDBOX_REPOS",
    "JARVIS_GITHUB_REVIEWER",
];

afterEach(() => {
    for (const key of VARS) {
        delete process.env[key];
    }
});

describe("GitHub App config", () => {
    it("is absent until the App id, key and installation are all present", () => {
        expect(getGitHubConfig()).toBeNull();

        process.env.JARVIS_GITHUB_APP_ID = "12345";
        process.env.JARVIS_GITHUB_INSTALLATION_ID = "67890";
        expect(getGitHubConfig()).toBeNull();

        process.env.JARVIS_GITHUB_APP_PRIVATE_KEY = "-----BEGIN KEY-----";
        expect(getGitHubConfig()).toMatchObject({
            appId: "12345",
            installationId: "67890",
            privateKey: "-----BEGIN KEY-----",
            apiBaseUrl: "https://api.github.com",
            repos: [],
            reviewer: null,
        });
    });

    it("reads the reviewer login, and leaves it to the owner when unset", () => {
        process.env.JARVIS_GITHUB_APP_ID = "12345";
        process.env.JARVIS_GITHUB_INSTALLATION_ID = "67890";
        process.env.JARVIS_GITHUB_APP_PRIVATE_KEY = "-----BEGIN KEY-----";

        expect(getGitHubConfig()?.reviewer).toBeNull();

        process.env.JARVIS_GITHUB_REVIEWER = "luke-human";
        expect(getGitHubConfig()?.reviewer).toBe("luke-human");
    });

    it("takes its repository allowlist from JARVIS_GITHUB_REPOS", () => {
        process.env.JARVIS_GITHUB_APP_ID = "12345";
        process.env.JARVIS_GITHUB_INSTALLATION_ID = "67890";
        process.env.JARVIS_GITHUB_APP_PRIVATE_KEY = "-----BEGIN KEY-----";
        process.env.JARVIS_GITHUB_REPOS = "luke/app, luke/other";

        expect(getGitHubConfig()?.repos).toEqual(["luke/app", "luke/other"]);
    });

    it("falls back to the sandbox allowlist when none is given", () => {
        process.env.JARVIS_GITHUB_APP_ID = "12345";
        process.env.JARVIS_GITHUB_INSTALLATION_ID = "67890";
        process.env.JARVIS_GITHUB_APP_PRIVATE_KEY = "-----BEGIN KEY-----";
        process.env.JARVIS_SANDBOX_REPOS = "luke/app";

        expect(getGitHubConfig()?.repos).toEqual(["luke/app"]);

        // An explicit list wins over the sandbox's.
        process.env.JARVIS_GITHUB_REPOS = "luke/other";
        expect(getGitHubConfig()?.repos).toEqual(["luke/other"]);
    });

    it("unescapes an inline key and honours an API host", () => {
        process.env.JARVIS_GITHUB_APP_ID = "12345";
        process.env.JARVIS_GITHUB_INSTALLATION_ID = "67890";
        process.env.JARVIS_GITHUB_APP_PRIVATE_KEY =
            "-----BEGIN KEY-----\\nbody\\n-----END KEY-----";
        process.env.JARVIS_GITHUB_API_BASE_URL =
            "https://github.enterprise.test/api";

        expect(getGitHubConfig()).toMatchObject({
            privateKey: "-----BEGIN KEY-----\nbody\n-----END KEY-----",
            apiBaseUrl: "https://github.enterprise.test/api",
        });
    });

    it("reads the key from a file when no inline one is set", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-github-key-"));
        try {
            const file = path.join(dir, "app.pem");
            writeFileSync(
                file,
                "-----BEGIN KEY-----\nfile\n-----END KEY-----\n",
            );
            process.env.JARVIS_GITHUB_APP_ID = "12345";
            process.env.JARVIS_GITHUB_INSTALLATION_ID = "67890";
            process.env.JARVIS_GITHUB_APP_PRIVATE_KEY_PATH = file;

            expect(getGitHubConfig()?.privateKey).toContain("file");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("treats a non-numeric App id as off", () => {
        process.env.JARVIS_GITHUB_APP_ID = "jarvis-coding-agent";
        process.env.JARVIS_GITHUB_INSTALLATION_ID = "67890";
        process.env.JARVIS_GITHUB_APP_PRIVATE_KEY = "-----BEGIN KEY-----";

        expect(getGitHubConfig()).toBeNull();
    });

    it("treats an unreadable key path as off rather than failing", () => {
        process.env.JARVIS_GITHUB_APP_ID = "12345";
        process.env.JARVIS_GITHUB_INSTALLATION_ID = "67890";
        process.env.JARVIS_GITHUB_APP_PRIVATE_KEY_PATH = path.join(
            tmpdir(),
            "jarvis-github-key-that-does-not-exist.pem",
        );

        expect(getGitHubConfig()).toBeNull();
    });
});
