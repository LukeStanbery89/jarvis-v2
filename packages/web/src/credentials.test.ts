/**
 * Unit tests for the browser credential store (injected fake storage — no
 * DOM required): round-trips, per-user namespacing, and sign-out semantics.
 */
import { describe, expect, it } from "vitest";
import { clearCredential, loadCredential, saveCredential } from "./credentials";
import { threadsKey } from "./threads";

/** In-memory Storage double for node tests. */
class FakeStorage implements Storage {
    private map = new Map<string, string>();

    get length(): number {
        return this.map.size;
    }

    clear(): void {
        this.map.clear();
    }

    getItem(key: string): string | null {
        return this.map.get(key) ?? null;
    }

    key(index: number): string | null {
        return [...this.map.keys()][index] ?? null;
    }

    removeItem(key: string): void {
        this.map.delete(key);
    }

    setItem(key: string, value: string): void {
        this.map.set(key, value);
    }
}

const CREDENTIAL = {
    username: "luke",
    userId: 7,
    token: "dvt_secret",
    device: { id: 3, name: "web-ab12", prefix: "dvt_ab12" },
};

describe("credentials store", () => {
    it("round-trips a saved credential", () => {
        const storage = new FakeStorage();
        saveCredential(storage, CREDENTIAL);
        expect(loadCredential(storage)).toEqual(CREDENTIAL);
    });

    it("loads null when no credential is active", () => {
        expect(loadCredential(new FakeStorage())).toBeNull();
    });

    it("loads null when parts are missing", () => {
        const storage = new FakeStorage();
        saveCredential(storage, CREDENTIAL);
        storage.removeItem("jarvis.web.user.luke.token");
        expect(loadCredential(storage)).toBeNull();
    });

    it("loads null on a corrupt device echo", () => {
        const storage = new FakeStorage();
        saveCredential(storage, CREDENTIAL);
        storage.setItem("jarvis.web.user.luke.device", "{not json");
        expect(loadCredential(storage)).toBeNull();
    });

    it("namespaces credentials per user without cross-user leaks", () => {
        const storage = new FakeStorage();
        saveCredential(storage, CREDENTIAL);
        saveCredential(storage, {
            ...CREDENTIAL,
            username: "other",
            userId: 9,
            token: "dvt_two",
        });
        expect(loadCredential(storage)?.username).toBe("other");
    });

    it("clear removes the token, user id, device echo, and pointer but keeps transcripts", () => {
        const storage = new FakeStorage();
        saveCredential(storage, CREDENTIAL);
        storage.setItem(threadsKey("luke"), "{}");
        clearCredential(storage);
        expect(loadCredential(storage)).toBeNull();
        expect(storage.getItem("jarvis.web.user.luke.token")).toBeNull();
        expect(storage.getItem("jarvis.web.user.luke.userId")).toBeNull();
        expect(storage.getItem("jarvis.web.user.luke.device")).toBeNull();
        expect(storage.getItem(threadsKey("luke"))).toBe("{}");
    });
});
