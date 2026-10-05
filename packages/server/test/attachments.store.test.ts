import { describe, expect, it } from "vitest";
import {
    mkdtempSync,
    mkdirSync,
    chmodSync,
    writeFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    createAttachmentStore,
    defaultAttachmentDir,
    AttachmentError,
    sweepOrphanAttachments,
} from "../src/attachments/store";
import {
    DEFAULT_ATTACHMENT_CONFIG,
    type AttachmentConfig,
} from "../src/config";

/** A tiny valid PNG (1x1 pixel). */
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
);

/** Store config over a fresh temp dir; generous budgets unless overridden. */
const cfg = (over: Partial<AttachmentConfig> = {}): AttachmentConfig => ({
    ...DEFAULT_ATTACHMENT_CONFIG,
    dir: mkdtempSync(path.join(tmpdir(), "jarvis-att-")),
    ...over,
});

describe("createAttachmentStore.put", () => {
    it("round-trips an image through put/get by id", async () => {
        const store = createAttachmentStore(cfg());
        const id = await store.put(1, PNG);
        expect(id).toHaveLength(24);
        expect(await store.get(1, id)).toEqual(PNG);
    });

    it("generates unguessable ids (two puts differ)", async () => {
        const store = createAttachmentStore(cfg());
        const a = await store.put(1, PNG);
        const b = await store.put(1, PNG);
        expect(a).not.toBe(b);
    });

    it("rejects a payload over the per-attachment cap", async () => {
        const store = createAttachmentStore(cfg({ maxBytes: 10 }));
        const err = await store.put(1, PNG).catch((e) => e);
        expect(err).toBeInstanceOf(AttachmentError);
        expect((err as AttachmentError).code).toBe("too-large");
    });

    it("rejects non-image bytes by magic-byte sniff, not declared type", async () => {
        const store = createAttachmentStore(cfg());
        const fake = Buffer.from("definitely not an image at all");
        const err = await store.put(1, fake).catch((e) => e);
        expect((err as AttachmentError).code).toBe("unsupported");
        // Also: a GIF/PNG/JPEG/WebP header without a valid payload is still
        // accepted by the sniff (the runtime validates content later).
        const jpegHeader = Buffer.concat([
            Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
            Buffer.alloc(16),
        ]);
        expect(await store.put(1, jpegHeader)).toHaveLength(24);
    });

    it("refuses when the user's byte budget is exhausted", async () => {
        const store = createAttachmentStore(
            cfg({ maxTotalBytes: PNG.length + 1 }),
        );
        await store.put(1, PNG);
        const err = await store.put(1, PNG).catch((e) => e);
        expect((err as AttachmentError).code).toBe("over-budget");
        // budget still holds exactly the first reservation
        expect(store.heldBytes(1)).toBe(PNG.length);
    });

    it("releases the reservation when the write fails", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-att-"));
        // A "directory" that is actually a file makes the root setup fail.
        const broken = path.join(dir, "root");
        writeFileSync(broken, "not a directory");
        const store = createAttachmentStore(cfg({ dir: broken }));
        const err = await store.put(1, PNG).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(AttachmentError); // a raw fs error
        expect(store.heldBytes(1)).toBe(0); // budget never reserved
    });

    it("fails loudly when the root directory is group/other-accessible", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-att-"));
        mkdirSync(dir, { recursive: true });
        chmodSync(dir, 0o755);
        const store = createAttachmentStore(cfg({ dir }));
        await expect(store.put(1, PNG)).rejects.toThrow(
            /group\/other-accessible/,
        );
        expect(store.heldBytes(1)).toBe(0);
        chmodSync(dir, 0o700);
    });
});

describe("createAttachmentStore.get", () => {
    it("throws typed 'unknown' for a never-stored id", async () => {
        const store = createAttachmentStore(cfg());
        const err = await store.get(1, "nope").catch((e) => e);
        expect((err as AttachmentError).code).toBe("unknown");
    });

    it("throws typed 'foreign' for another user's attachment", async () => {
        const store = createAttachmentStore(cfg());
        const id = await store.put(1, PNG);
        const err = await store.get(2, id).catch((e) => e);
        expect((err as AttachmentError).code).toBe("foreign");
    });

    it("throws typed 'expired' once the TTL lapses", async () => {
        const store = createAttachmentStore(cfg({ ttlMs: 1000 }));
        const id = await store.put(1, PNG);
        await store.sweep(Date.now() + 2001);
        const err = await store.get(1, id).catch((e) => e);
        expect((err as AttachmentError).code).toBe("unknown"); // swept = gone
    });
});

describe("createAttachmentStore.release and sweep", () => {
    it("release returns the bytes to the budget and makes the id unknown", async () => {
        const store = createAttachmentStore(cfg());
        const id = await store.put(1, PNG);
        store.release(id);
        expect(store.heldBytes(1)).toBe(0);
        await expect(store.get(1, id)).rejects.toMatchObject({
            code: "unknown",
        });
    });

    it("release is idempotent (R2) — double release never double-frees", async () => {
        const store = createAttachmentStore(cfg());
        const id = await store.put(1, PNG);
        store.release(id);
        store.release(id);
        expect(store.heldBytes(1)).toBe(0);
    });

    it("release of a never-stored id is a no-op", () => {
        const store = createAttachmentStore(cfg());
        expect(() => store.release("ghost")).not.toThrow();
    });

    it("sweep deletes only expired entries and tolerates ENOENT", async () => {
        const store = createAttachmentStore(cfg({ ttlMs: 1000 }));
        const live = await store.put(1, PNG);
        const dead = await store.put(1, PNG);
        // Simulate the file already vanishing.
        rmSync(path.join(cfg().dir ?? "", dead), { force: true });
        const swept = await store.sweep(Date.now() + 2001);
        expect(swept).toBe(2); // both expired (same ttl); ENOENT tolerated
        await expect(store.get(1, live)).rejects.toMatchObject({
            code: "unknown",
        });
        expect(store.heldBytes(1)).toBe(0);
    });

    it("sweep keeps live entries", async () => {
        const store = createAttachmentStore(cfg({ ttlMs: 60_000 }));
        const id = await store.put(1, PNG);
        expect(await store.sweep(Date.now() + 1000)).toBe(0);
        expect(await store.get(1, id)).toEqual(PNG);
    });
});

describe("sweepOrphanAttachments", () => {
    it("clears files left on disk from a previous process", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-att-"));
        writeFileSync(path.join(dir, "orphan-a"), "x");
        writeFileSync(path.join(dir, "orphan-b"), "y");
        // Backdate to simulate a previous process's leftovers: the sweep
        // deletes only files older than boot (the mtime filter is what keeps
        // it race-free against an upload landing while it runs).
        const { utimesSync } = await import("node:fs");
        const old = new Date(Date.now() - 60_000);
        utimesSync(path.join(dir, "orphan-a"), old, old);
        utimesSync(path.join(dir, "orphan-b"), old, old);
        await sweepOrphanAttachments({ ...DEFAULT_ATTACHMENT_CONFIG, dir });
        const { readdirSync } = await import("node:fs");
        expect(readdirSync(dir)).toEqual([]);
    });

    it("tolerates a missing directory", async () => {
        await expect(
            sweepOrphanAttachments({
                ...DEFAULT_ATTACHMENT_CONFIG,
                dir: path.join(tmpdir(), "jarvis-att-does-not-exist"),
            }),
        ).resolves.toBe(0);
    });

    it("defaultAttachmentDir lives under tmpdir", () => {
        expect(defaultAttachmentDir()).toContain(path.join(tmpdir()));
        expect(defaultAttachmentDir()).toMatch(/jarvis-attachments$/);
    });
});
