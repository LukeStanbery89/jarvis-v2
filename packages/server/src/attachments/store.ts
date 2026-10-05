/**
 * Transient attachment storage for the image-analysis surface (#10).
 *
 * Owns the temp-file lifecycle for images a chat prompt references: uploads
 * land as files under a private root, addressed by an opaque id, and are
 * swept when their TTL lapses. State is deliberately **in-memory registry +
 * files on disk** — nothing survives a restart (the directory is emptied at
 * startup), because attachments exist so a model can look at a photo within
 * a few minutes of the upload, not as durable storage. Persistence is a
 * roadmap concern (camera capture, face→user, save/export) that would add a
 * ledger table; this store keeps that future open by being the single place
 * that knows ids and paths.
 *
 * Security posture:
 * - ids are 18 random bytes (24 base64url chars) — unguessable, so an id is
 *   a capability; ownership is *also* checked on every `get` (id theft must
 *   not cross the user boundary),
 * - the root directory is mode-verified before first use: group/other access
 *   bits are a loud misconfiguration error, not a warning (`ensurePrivateDir`
 *   only tightens directories it created, so a pre-existing permissive
 *   directory would otherwise slip through — review finding B6),
 * - every upload is validated by magic-byte sniffing, never by a declared
 *   mime type, so crafted non-image bytes cannot reach the ML runtime,
 * - the byte ledger is reserved only after sniffing passes, and released on
 *   write failure; releases are idempotent (keyed on registry-entry
 *   presence), so a retry after a partial failure cannot double-free budget.
 */
import { randomBytes } from "node:crypto";
import {
    mkdir,
    readFile,
    readdir,
    stat,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AttachmentConfig } from "../config";
import { logger } from "../logger";
import { ByteLedger } from "./limiters";

/** Why an attachment operation was refused; drives HTTP status and tool text. */
export type AttachmentErrorCode =
    /** `get`: no attachment with that id exists (or it was already swept). */
    | "unknown"
    /** `get`: the attachment's TTL lapsed. */
    | "expired"
    /** `get`: the attachment belongs to another user. */
    | "foreign"
    /** `put`: the bytes are not a recognized image (magic-byte sniff failed). */
    | "unsupported"
    /** `put`: one attachment exceeds the per-attachment byte cap. */
    | "too-large"
    /** `put`: the user is over their total-attachment budget. */
    | "over-budget";

/** A typed attachment failure; `message` is safe to relay to the client. */
export class AttachmentError extends Error {
    constructor(
        /** Machine-readable reason (maps to HTTP status / tool handling). */
        readonly code: AttachmentErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "AttachmentError";
    }
}

/** An attachment's registry entry. */
interface Entry {
    /** Owning user's numeric row id; the only principal that may `get` it. */
    userId: number;
    /** Decoded byte size (also what the ledger holds). */
    bytes: number;
    /** Absolute path of the temp file. */
    filePath: string;
    /** Epoch ms when the entry stops being valid. */
    expiresAt: number;
}

/** The store seam consumed by routes, `ws.ts`, and the `analyzeImage` tool. */
export interface AttachmentStore {
    /**
     * Stores an uploaded image for `userId`, returning its id.
     *
     * `bytes` must be the decoded image. Order of checks: per-attachment cap,
     * magic-byte sniff, byte-ledger reserve, then the write — a failed write
     * releases the reservation (idempotently), so budget never leaks.
     */
    put(userId: number, bytes: Buffer): Promise<string>;

    /**
     * Returns the decoded bytes of attachment `id` for `userId`.
     *
     * Throws {@link AttachmentError} with code `unknown`, `expired`, or
     * `foreign` — callers map those onto user-safe text rather than
     * distinguishing existence to untrusted parties.
     */
    get(userId: number, id: string): Promise<Buffer>;

    /**
     * Checks attachment `id` is resolvable by `userId` without reading it.
     *
     * Same checks as {@link get} (existence, expiry, ownership) but no disk
     * I/O — the socket layer validates every referenced id before claiming a
     * turn, so a bad id fails fast instead of surfacing mid-stream as a tool
     * error. Throws {@link AttachmentError} like `get` does.
     */
    assertAccessible(userId: number, id: string): void;

    /**
     * Drops attachment `id` and returns its bytes to the budget.
     *
     * Idempotent: an id that was never stored (or was already released) is a
     * no-op, so a caller's failure-retry path cannot double-free. Uncouples
     * the unlink — a missing file (`ENOENT`) is tolerated, not thrown.
     */
    release(id: string): void;

    /**
     * Deletes every expired entry (and its file), returning how many went.
     *
     * Tolerates `ENOENT` on unlink — the file may already be gone. Called at
     * startup and fired after each upload; never throws on absent directory.
     */
    sweep(now?: number): Promise<number>;

    /** Bytes currently held for `userId` (exposed for tests/monitoring). */
    heldBytes(userId: number): number;
}

/** Image format signatures, checked against the decoded bytes. */
export function sniffImageMime(bytes: Buffer): string | null {
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return "image/png";
    }
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return "image/jpeg";
    }
    if (
        bytes.length >= 6 &&
        bytes.subarray(0, 3).toString("ascii") === "GIF" &&
        (bytes.subarray(3, 6).toString("ascii") === "87a" ||
            bytes.subarray(3, 6).toString("ascii") === "89a")
    ) {
        return "image/gif";
    }
    if (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
        return "image/webp";
    }
    return null;
}

/** The root directory when the operator has not set one. */
export function defaultAttachmentDir(): string {
    return path.join(tmpdir(), "jarvis-attachments");
}

/**
 * Builds an attachment store over `config`.
 *
 * Factory, not a singleton: callers (production wiring, tests) construct
 * their own instance and inject it — the agent graph never builds one, so
 * tests that replace the agent module stay independent of the filesystem.
 * Creates the root directory on first use and **verifies** its mode with
 * `stat`: group/other access bits fail loudly (review finding B6).
 */
export function createAttachmentStore(
    config: AttachmentConfig,
): AttachmentStore {
    const root = config.dir ?? defaultAttachmentDir();
    const ledger = new ByteLedger(config.maxTotalBytes);
    /** id → entry; the presence test makes `release` idempotent (R2). */
    const registry = new Map<string, Entry>();
    /** Set once per process: the directory posture has been verified. */
    let verified: Promise<void> | null = null;

    /** Creates (if needed) and verifies the root directory's mode. */
    const ensurePrivateRoot = async (): Promise<void> => {
        if (verified) {
            return verified;
        }
        verified = (async () => {
            await mkdir(root, { recursive: true, mode: 0o700 });
            const st = await stat(root);
            // Group/other bits (rwx for g and o) must be absent. A directory
            // we did not create may carry any mode; refuse rather than chmod
            // silently — the operator chose that directory.
            if (st.mode & 0o077) {
                throw new Error(
                    `attachment directory ${root} is group/other-accessible (mode ${(st.mode & 0o777).toString(8)}); refusing to store images in it`,
                );
            }
        })();
        return verified;
    };

    const attachmentPath = (id: string): string => path.join(root, id);

    /**
     * Shared `get`/`assertAccessible` resolution: existence, expiry, then
     * ownership, in that order — an expired entry answers `expired` even
     * before it is swept, and a foreign id answers `foreign` without
     * revealing whether it exists.
     */
    const resolveEntry = (userId: number, id: string): Entry => {
        const entry = registry.get(id);
        if (!entry) {
            throw new AttachmentError("unknown", `no attachment '${id}'`);
        }
        if (Date.now() >= entry.expiresAt) {
            throw new AttachmentError(
                "expired",
                "attachment expired; upload it again",
            );
        }
        if (entry.userId !== userId) {
            throw new AttachmentError(
                "foreign",
                "attachment belongs to another user",
            );
        }
        return entry;
    };

    return {
        async put(userId: number, bytes) {
            if (bytes.length > config.maxBytes) {
                throw new AttachmentError(
                    "too-large",
                    `attachment exceeds the ${config.maxBytes}-byte cap`,
                );
            }
            if (!sniffImageMime(bytes)) {
                throw new AttachmentError(
                    "unsupported",
                    "attachment is not a recognized image (PNG, JPEG, GIF, WebP)",
                );
            }
            // Mode posture before reserving: a refused store must not leak a
            // ledger reservation (the directory is cheap to verify after the
            // first call — the promise is memoized).
            await ensurePrivateRoot();
            if (!ledger.tryReserve(userId, bytes.length)) {
                throw new AttachmentError(
                    "over-budget",
                    "attachment storage budget exhausted; delete old conversations or retry later",
                );
            }
            const id = randomBytes(18).toString("base64url");
            try {
                await writeFile(attachmentPath(id), bytes, { mode: 0o600 });
            } catch (err) {
                // The reservation must not leak on a failed write.
                ledger.release(userId, bytes.length);
                throw err;
            }
            registry.set(id, {
                userId,
                bytes: bytes.length,
                filePath: attachmentPath(id),
                expiresAt: Date.now() + config.ttlMs,
            });
            return id;
        },

        async get(userId: number, id: string) {
            const entry = resolveEntry(userId, id);
            return readFile(entry.filePath);
        },

        assertAccessible(userId: number, id: string) {
            resolveEntry(userId, id);
        },

        release(id) {
            const entry = registry.get(id);
            if (!entry) {
                return; // already released (or never stored) — idempotent no-op
            }
            registry.delete(id);
            ledger.release(entry.userId, entry.bytes);
            void unlink(entry.filePath).catch((err: NodeJS.ErrnoException) => {
                if (err.code !== "ENOENT") {
                    logger.warn(
                        `Failed to unlink attachment ${id}: ${err.message}`,
                    );
                }
            });
        },

        async sweep(now = Date.now()) {
            let swept = 0;
            for (const [id, entry] of registry) {
                if (now >= entry.expiresAt) {
                    registry.delete(id);
                    ledger.release(entry.userId, entry.bytes);
                    swept += 1;
                    await unlink(entry.filePath).catch(
                        (err: NodeJS.ErrnoException) => {
                            if (err.code !== "ENOENT") {
                                logger.warn(
                                    `Sweep failed to unlink ${id}: ${err.message}`,
                                );
                            }
                        },
                    );
                }
            }
            return swept;
        },

        heldBytes(userId) {
            return ledger.heldBytes(userId);
        },
    };
}

/**
 * Empties pre-process files out of the attachment root at startup.
 *
 * The registry is in-memory, so any file still on disk when the process
 * boots is an orphan nothing can ever resolve; deleting it is the
 * "swept at startup" half of the TTL story (the other half is the lazy
 * `sweep()` on upload). Files written by THIS process are never older than
 * `bootedAt`, so the mtime filter keeps the sweep race-free against an
 * upload landing while it runs. Tolerates a missing directory; other errors
 * are logged, not thrown — attachments are a feature, not a startup
 * dependency.
 */
export async function sweepOrphanAttachments(
    config: AttachmentConfig,
    bootedAt: number = Date.now(),
): Promise<number> {
    const root = config.dir ?? defaultAttachmentDir();
    try {
        const names = await readdir(root);
        let removed = 0;
        for (const name of names) {
            const filePath = path.join(root, name);
            const st = await stat(filePath).catch(() => null);
            if (!st || st.mtimeMs >= bootedAt) {
                continue; // written by this process (or vanished) — keep
            }
            await unlink(filePath).catch(() => {});
            removed += 1;
        }
        if (removed > 0) {
            logger.info(
                `Attachment store: cleared ${removed} orphan(s) from ${root}`,
            );
        }
        return removed;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn(
                `Attachment store startup sweep failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        return 0;
    }
}
