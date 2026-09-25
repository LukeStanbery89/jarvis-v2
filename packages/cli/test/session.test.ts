import { afterEach, describe, expect, it } from "vitest";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    generateSessionId,
    loadSessionIds,
    rotateActiveSession,
    saveSessionIds,
    sessionIdFor,
    type SessionIdentity,
    type SessionIds,
} from "../src/session";

/** Points JARVIS_SESSION_FILE at a fresh temp path and returns the path. */
function useTempSessionFile(subdir = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-session-"));
    const path = join(dir, subdir, "session-id");
    process.env.JARVIS_SESSION_FILE = path;
    return path;
}

/** In-memory identity helpers: the same shapes `index.ts` builds. */
const guest: SessionIdentity = { kind: "guest" };
const user = (username: string): SessionIdentity => ({
    kind: "user",
    username,
});

afterEach(() => {
    delete process.env.JARVIS_SESSION_FILE;
});

describe("loadSessionIds", () => {
    it("starts with a fresh guest id when no file exists", () => {
        useTempSessionFile();
        const ids = loadSessionIds();

        expect(ids.version).toBe(1);
        expect(ids.guest).toBeTruthy();
        expect(ids.users).toEqual({});
    });

    it("adopts a legacy bare-uuid file as the guest id", () => {
        const path = useTempSessionFile();
        writeFileSync(path, "some-legacy-id-123");

        const ids = loadSessionIds();
        expect(ids.guest).toBe("some-legacy-id-123");
        expect(ids.users).toEqual({});
    });

    it("returns a fresh store for a malformed file", () => {
        const path = useTempSessionFile();
        writeFileSync(path, "{ not json");

        const ids = loadSessionIds();
        expect(ids.guest).toBeTruthy();
        expect(ids.users).toEqual({});
    });

    it("round-trips an existing store", () => {
        const path = useTempSessionFile();
        const original: SessionIds = {
            version: 1,
            guest: "guest-1",
            users: { luke: "luke-1" },
        };
        saveSessionIds(original);

        expect(loadSessionIds()).toEqual(original);
        expect(readFileSync(path, "utf8")).toContain("luke-1");
    });
});

describe("saveSessionIds", () => {
    it("writes the store at 0600 and creates directories at 0700", () => {
        const path = useTempSessionFile("nested");
        const ids: SessionIds = {
            version: 1,
            guest: "guest-1",
            users: {},
        };
        saveSessionIds(ids);

        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    });

    it("throws when the file cannot be written", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-session-"));
        // A non-directory parent makes every write to the path fail.
        process.env.JARVIS_SESSION_FILE = join(dir, "file", "session-id");
        writeFileSync(join(dir, "file"), "not a directory");

        expect(() =>
            saveSessionIds({ version: 1, guest: "g", users: {} }),
        ).toThrow(/could not write session-id file/);
    });
});

describe("sessionIdFor", () => {
    it("resolves the guest slot without mutating it", () => {
        useTempSessionFile();
        const ids = loadSessionIds();

        expect(sessionIdFor(ids, guest)).toBe(ids.guest);
        expect(sessionIdFor(ids, guest)).toBe(ids.guest);
    });

    it("resumes a remembered username across calls", () => {
        useTempSessionFile();
        const ids = loadSessionIds();
        ids.users.luke = "luke-thread-1";

        expect(sessionIdFor(ids, user("luke"))).toBe("luke-thread-1");
        expect(sessionIdFor(ids, user("luke"))).toBe("luke-thread-1");
    });

    it("mints and persists a fresh id for a new username", () => {
        const path = useTempSessionFile();
        const ids = loadSessionIds();

        const id = sessionIdFor(ids, user("zoe"));
        expect(id).toBeTruthy();
        expect(sessionIdFor(ids, user("zoe"))).toBe(id);
        expect(JSON.parse(readFileSync(path, "utf8")).users.zoe).toBe(id);
    });

    it("keeps guest and user threads distinct", () => {
        useTempSessionFile();
        const ids = loadSessionIds();

        const guestId = sessionIdFor(ids, guest);
        const lukeId = sessionIdFor(ids, user("luke"));

        expect(lukeId).not.toBe(guestId);
        expect(sessionIdFor(ids, guest)).toBe(guestId);
        expect(sessionIdFor(ids, user("luke"))).toBe(lukeId);
    });
});

describe("rotateActiveSession", () => {
    it("rotates the guest slot and persists", () => {
        const path = useTempSessionFile();
        const ids = loadSessionIds();
        const before = ids.guest;

        const rotated = rotateActiveSession(ids, guest);
        expect(rotated).toBe(ids.guest);
        expect(rotated).not.toBe(before);
        expect(JSON.parse(readFileSync(path, "utf8")).guest).toBe(rotated);
    });

    it("rotates only the active user's slot", () => {
        const path = useTempSessionFile();
        const ids = loadSessionIds();
        ids.users.luke = "luke-1";
        ids.users.zoe = "zoe-1";

        const rotated = rotateActiveSession(ids, user("luke"));
        expect(rotated).toBe(ids.users.luke);
        expect(rotated).not.toBe("luke-1");
        expect(ids.users.zoe).toBe("zoe-1");
        const persisted = JSON.parse(readFileSync(path, "utf8")).users;
        expect(persisted.luke).toBe(rotated);
        expect(persisted.zoe).toBe("zoe-1");
    });
});

describe("generateSessionId", () => {
    it("produces unique ids within the server's length bound", () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i += 1) {
            const id = generateSessionId();
            expect(id.length).toBeGreaterThan(0);
            expect(id.length).toBeLessThanOrEqual(128);
            ids.add(id);
        }
        expect(ids.size).toBe(100);
    });

    it("leaves the on-disk file untouched when unused", () => {
        const path = useTempSessionFile();
        writeFileSync(path, "legacy-id");
        generateSessionId();
        expect(readFileSync(path, "utf8")).toBe("legacy-id");
        expect(existsSync(path)).toBe(true);
    });
});
