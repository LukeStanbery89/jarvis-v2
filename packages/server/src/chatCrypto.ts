/**
 * At-rest encryption for conversation content (#122).
 *
 * The transcript table stores an opaque ciphertext envelope per message, and
 * the session title is encrypted the same way. Checkpoints are encrypted at
 * the serializer boundary (`llm/encryptedSerde.ts`) so the model's own memory
 * does not leave plaintext on disk either.
 *
 * AES-256-GCM is used deliberately: Node ships it, it needs no native SQLite
 * rebuild, and the envelope can grow a key id / version without changing the
 * database schema. The key is a secret; the envelope is the only thing that
 * ever reaches a log or an error message.
 */
import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
    ensurePrivateFile,
    ensurePrivateStorage,
} from "@lukestanbery/jarvis-auth";
import { logger } from "./logger";

/** The algorithms/format this module writes today. */
const ENVELOPE_PREFIX = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** The encryption surface used by transcripts, titles, and the checkpointer. */
export interface ChatCipher {
    /** Encrypts UTF-8 text into the `v1:…` transport envelope. */
    encrypt(plaintext: string): string;
    /** Decrypts an envelope produced by {@link encrypt}. */
    decrypt(envelope: string): string;
    /** Encrypts a JSON-serializable value. */
    encryptJson(value: unknown): string;
    /** Decrypts a value produced by {@link encryptJson}. */
    decryptJson<T>(envelope: string): T;
}

/** Options for {@link resolveChatKey}. */
export interface ChatKeyOptions {
    /** Environment map (injectable for tests). Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Home directory used for the dev key file. Defaults to `os.homedir()`. */
    home?: string;
    /** Whether a missing key is fatal (production) or may be generated (dev). */
    production?: boolean;
    /** Overrides the key-file path. */
    keyFile?: string;
}

/** Returns the private dev key path, or the configured override. */
export function chatKeyPath(
    options: Pick<ChatKeyOptions, "env" | "home" | "keyFile"> = {},
): string {
    const env = options.env ?? process.env;
    return (
        options.keyFile ??
        env.JARVIS_CHAT_KEY_FILE ??
        path.join(options.home ?? homedir(), ".jarvis", "chat.key")
    );
}

/** Parses a 32-byte key from base64 (the documented format). */
function parseKey(text: string, source: string): Buffer {
    let key: Buffer;
    try {
        key = Buffer.from(text.trim(), "base64");
    } catch {
        throw new Error(
            `chat encryption key from ${source} is not valid base64`,
        );
    }
    if (key.length !== KEY_BYTES) {
        throw new Error(
            `chat encryption key from ${source} must be ${KEY_BYTES} bytes (got ${key.length})`,
        );
    }
    return key;
}

/**
 * Resolves the process's chat-encryption key.
 *
 * Production requires `JARVIS_CHAT_ENCRYPTION_KEY` (base64, 32 bytes) and
 * refuses to start without it. Development generates a `0600` key file on
 * first use, so local debugging has a stable cipher without a checked-in
 * secret; losing that file means the encrypted rows are unreadable, which is
 * why it is never silently regenerated when a key file already exists.
 *
 * @param options - Injection points for tests and alternate deployments.
 * @returns A 32-byte key buffer.
 */
export function resolveChatKey(options: ChatKeyOptions = {}): Buffer {
    const env = options.env ?? process.env;
    const configured = env.JARVIS_CHAT_ENCRYPTION_KEY?.trim();
    if (configured) {
        return parseKey(configured, "JARVIS_CHAT_ENCRYPTION_KEY");
    }
    const production =
        options.production ??
        (env.NODE_ENV === "production" || env.JARVIS_CHAT_KEY_REQUIRED === "1");
    if (production) {
        throw new Error(
            "JARVIS_CHAT_ENCRYPTION_KEY is required in production (base64, 32 bytes)",
        );
    }
    const keyPath = chatKeyPath(options);
    if (existsSync(keyPath)) {
        return parseKey(readFileSync(keyPath, "utf8"), keyPath);
    }
    const key = randomBytes(KEY_BYTES);
    ensurePrivateStorage(keyPath);
    writeFileSync(keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
    ensurePrivateFile(keyPath);
    logger.warn(
        `Generated a development chat encryption key at ${keyPath}; back it up if you want to keep this history`,
    );
    return key;
}

/**
 * Builds the AES-256-GCM cipher over `key`.
 *
 * The envelope is `v1:<iv>:<tag>:<ciphertext>`, all base64. Text rather than
 * raw bytes on purpose: `SqliteSaver` reads pending writes with
 * `CAST(value AS TEXT)`, so a binary ciphertext would be corrupted there.
 *
 * @param key - A 32-byte key.
 * @returns The cipher seam.
 */
export function createChatCipher(key: Buffer): ChatCipher {
    if (key.length !== KEY_BYTES) {
        throw new Error(`chat encryption key must be ${KEY_BYTES} bytes`);
    }
    const keyCopy = Buffer.from(key);
    return {
        encrypt(plaintext) {
            const iv = randomBytes(IV_BYTES);
            const cipher = createCipheriv("aes-256-gcm", keyCopy, iv);
            const ciphertext = Buffer.concat([
                cipher.update(plaintext, "utf8"),
                cipher.final(),
            ]);
            const tag = cipher.getAuthTag();
            return [
                ENVELOPE_PREFIX,
                iv.toString("base64"),
                tag.toString("base64"),
                ciphertext.toString("base64"),
            ].join(":");
        },
        decrypt(envelope) {
            const parts = envelope.split(":");
            if (parts.length !== 4 || parts[0] !== ENVELOPE_PREFIX) {
                throw new Error("chat ciphertext has an unsupported envelope");
            }
            const iv = Buffer.from(parts[1], "base64");
            const tag = Buffer.from(parts[2], "base64");
            const ciphertext = Buffer.from(parts[3], "base64");
            if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
                throw new Error("chat ciphertext has a malformed nonce or tag");
            }
            const decipher = createDecipheriv("aes-256-gcm", keyCopy, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([
                decipher.update(ciphertext),
                decipher.final(),
            ]).toString("utf8");
        },
        encryptJson(value) {
            return this.encrypt(JSON.stringify(value));
        },
        decryptJson<T>(envelope: string): T {
            return JSON.parse(this.decrypt(envelope)) as T;
        },
    };
}

/**
 * Compares two key buffers without leaking the first differing byte.
 *
 * A small exported helper because key tests and future rotation code should
 * not hand-roll a secret comparison.
 */
export function sameKey(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
}
