/**
 * At-rest chat encryption (#122): envelope round-trips, authenticated
 * tamper detection, and the production/dev key policy.
 */
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    chatKeyPath,
    createChatCipher,
    resolveChatKey,
    sameKey,
} from "../src/chatCrypto";

const KEY = Buffer.alloc(32, 7);
const dirs: string[] = [];

function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "jarvis-chat-key-"));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("createChatCipher", () => {
    it("round-trips text and JSON with a fresh nonce each time", () => {
        const cipher = createChatCipher(KEY);
        const first = cipher.encrypt("hello");
        const second = cipher.encrypt("hello");
        expect(first).not.toBe(second);
        expect(first.startsWith("v1:")).toBe(true);
        expect(cipher.decrypt(first)).toBe("hello");
        const value = { text: "hi", n: 2 };
        expect(cipher.decryptJson(cipher.encryptJson(value))).toEqual(value);
    });

    it("rejects a different key and tampered ciphertext", () => {
        const cipher = createChatCipher(KEY);
        const other = createChatCipher(Buffer.alloc(32, 8));
        const envelope = cipher.encrypt("secret");
        expect(() => other.decrypt(envelope)).toThrow();
        const parts = envelope.split(":");
        const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from(
            "nope",
        ).toString("base64")}`;
        expect(() => cipher.decrypt(tampered)).toThrow();
        expect(() => cipher.decrypt("not-an-envelope")).toThrow(
            /unsupported envelope/,
        );
    });

    it("enforces the 32-byte key size", () => {
        expect(() => createChatCipher(Buffer.alloc(16))).toThrow(/32 bytes/);
    });
});

describe("resolveChatKey", () => {
    it("uses the production environment value", () => {
        const key = resolveChatKey({
            env: {
                NODE_ENV: "production",
                JARVIS_CHAT_ENCRYPTION_KEY: KEY.toString("base64"),
            },
            production: true,
        });
        expect(sameKey(key, KEY)).toBe(true);
    });

    it("fails closed in production without a key", () => {
        expect(() =>
            resolveChatKey({
                env: { NODE_ENV: "production" },
                production: true,
            }),
        ).toThrow(/JARVIS_CHAT_ENCRYPTION_KEY/);
    });

    it("generates a private development key file once and reuses it", () => {
        const dir = tempDir();
        const keyFile = path.join(dir, ".jarvis", "chat.key");
        const options = {
            env: {},
            production: false,
            keyFile,
        };
        const first = resolveChatKey(options);
        const second = resolveChatKey(options);
        expect(sameKey(first, second)).toBe(true);
        expect(statSync(keyFile).mode & 0o777).toBe(0o600);
        expect(readFileSync(keyFile, "utf8").trim()).toBe(
            first.toString("base64"),
        );
        expect(chatKeyPath(options)).toBe(keyFile);
        chmodSync(keyFile, 0o600);
    });
});
