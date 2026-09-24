import { afterEach, describe, expect, it } from "vitest";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearCredentials,
    loadCredentials,
    saveCredentials,
} from "../src/credentials";
import {
    defaultCredentialsFilePath,
    getCredentialsFilePath,
} from "../src/config";

const ORIGIN_A = "http://localhost:54321";
const ORIGIN_B = "http://192.168.1.10:54321";

const CREDS = {
    token: "tok-123",
    user: "luke",
    device: "macbook",
    savedAt: "2026-09-22T00:00:00.000Z",
};

/** Points JARVIS_CREDENTIALS_FILE at a fresh temp path and returns the path. */
function useTempCredentialsFile(subdir = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-credentials-"));
    const path = join(dir, subdir, "credentials.json");
    process.env.JARVIS_CREDENTIALS_FILE = path;
    return path;
}

afterEach(() => {
    delete process.env.JARVIS_CREDENTIALS_FILE;
});

describe("credentials", () => {
    it("saves and loads credentials for an origin", () => {
        const path = useTempCredentialsFile();
        saveCredentials(ORIGIN_A, CREDS);

        expect(loadCredentials(ORIGIN_A)).toEqual(CREDS);
        expect(readFileSync(path, "utf8")).toContain(ORIGIN_A);
    });

    it("keys entries by server origin", () => {
        useTempCredentialsFile();
        saveCredentials(ORIGIN_A, CREDS);
        saveCredentials(ORIGIN_B, { ...CREDS, user: "sam", device: "pi" });

        expect(loadCredentials(ORIGIN_A)).toEqual(CREDS);
        expect(loadCredentials(ORIGIN_B)).toEqual({
            ...CREDS,
            user: "sam",
            device: "pi",
        });
    });

    it("overwrites an existing entry for the same origin", () => {
        useTempCredentialsFile();
        saveCredentials(ORIGIN_A, CREDS);
        saveCredentials(ORIGIN_A, { ...CREDS, token: "tok-rotated" });

        expect(loadCredentials(ORIGIN_A)).toEqual({
            ...CREDS,
            token: "tok-rotated",
        });
    });

    it("creates the file at 0600 and new directories at 0700", () => {
        const path = useTempCredentialsFile("nested");
        saveCredentials(ORIGIN_A, CREDS);

        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    });

    it("keeps an existing file at 0600 after saving", () => {
        const path = useTempCredentialsFile();
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "{}", { mode: 0o644 });
        saveCredentials(ORIGIN_A, CREDS);

        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it("returns null when no file exists", () => {
        useTempCredentialsFile();
        expect(loadCredentials(ORIGIN_A)).toBeNull();
    });

    it("ignores a malformed file", () => {
        const path = useTempCredentialsFile();
        writeFileSync(path, "not json");

        expect(loadCredentials(ORIGIN_A)).toBeNull();
        expect(existsSync(path)).toBe(true);
    });

    it("ignores a file with an unexpected shape", () => {
        const path = useTempCredentialsFile();
        writeFileSync(path, JSON.stringify({ hello: 1 }));

        expect(loadCredentials(ORIGIN_A)).toBeNull();
    });

    it("ignores a malformed entry for the origin", () => {
        const path = useTempCredentialsFile();
        writeFileSync(
            path,
            JSON.stringify({
                version: 1,
                servers: { [ORIGIN_A]: { user: "luke" } },
            }),
        );

        expect(loadCredentials(ORIGIN_A)).toBeNull();
    });

    it("clears an entry and reports missing ones", () => {
        useTempCredentialsFile();
        saveCredentials(ORIGIN_A, CREDS);

        expect(clearCredentials(ORIGIN_A)).toBe(true);
        expect(loadCredentials(ORIGIN_A)).toBeNull();
        expect(clearCredentials(ORIGIN_A)).toBe(false);
        expect(clearCredentials(ORIGIN_B)).toBe(false);
    });

    it("clearing one origin preserves the others", () => {
        useTempCredentialsFile();
        saveCredentials(ORIGIN_A, CREDS);
        saveCredentials(ORIGIN_B, { ...CREDS, user: "sam" });

        expect(clearCredentials(ORIGIN_A)).toBe(true);

        expect(loadCredentials(ORIGIN_A)).toBeNull();
        expect(loadCredentials(ORIGIN_B)).toEqual({
            ...CREDS,
            user: "sam",
        });
    });

    it("throws instead of silently losing the token when the write fails", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-credentials-"));
        // A non-directory parent makes every write to the path fail.
        process.env.JARVIS_CREDENTIALS_FILE = join(dir, "file", "creds.json");
        writeFileSync(join(dir, "file"), "not a directory");

        expect(() => saveCredentials(ORIGIN_A, CREDS)).toThrow(
            /could not write credentials file/,
        );
    });
});

describe("getCredentialsFilePath", () => {
    it("defaults to ~/.jarvis/credentials.json", () => {
        delete process.env.JARVIS_CREDENTIALS_FILE;
        expect(getCredentialsFilePath()).toBe(
            `${homedir()}/.jarvis/credentials.json`,
        );
        expect(defaultCredentialsFilePath()).toBe(
            `${homedir()}/.jarvis/credentials.json`,
        );
    });

    it("honours JARVIS_CREDENTIALS_FILE", () => {
        process.env.JARVIS_CREDENTIALS_FILE = "/tmp/jarvis-creds";
        expect(getCredentialsFilePath()).toBe("/tmp/jarvis-creds");
    });
});
