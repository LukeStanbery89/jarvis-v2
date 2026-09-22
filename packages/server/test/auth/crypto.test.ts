import { describe, expect, it } from "vitest";
import {
    AuthError,
    generateDeviceToken,
    hashDeviceToken,
    hashPassword,
    verifyPassword,
    type ScryptParams,
} from "../../src/auth";

/** Test scrypt cost: fast enough to hash many times, still scrypt. */
const FAST_SCRYPT: ScryptParams = { N: 4, r: 1, p: 1 };

describe("hashPassword / verifyPassword", () => {
    it("hashes into a self-describing scrypt string", async () => {
        const hash = await hashPassword("hunter2", FAST_SCRYPT);
        const parts = hash.split("$");
        expect(parts).toHaveLength(6);
        expect(parts[0]).toBe("scrypt");
        expect(parts[1]).toBe("4");
        expect(parts[2]).toBe("1");
        expect(parts[3]).toBe("1");
    });

    it("salts: the same password hashes differently each time", async () => {
        const a = await hashPassword("same", FAST_SCRYPT);
        const b = await hashPassword("same", FAST_SCRYPT);
        expect(a).not.toBe(b);
    });

    it("verifies the correct password", async () => {
        const hash = await hashPassword("hunter2", FAST_SCRYPT);
        await expect(verifyPassword("hunter2", hash)).resolves.toBe(true);
    });

    it("rejects a wrong password", async () => {
        const hash = await hashPassword("hunter2", FAST_SCRYPT);
        await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
    });

    it("throws a malformed-hash AuthError for a corrupt stored hash", async () => {
        await expect(
            verifyPassword("x", "not-a-scrypt-string"),
        ).rejects.toBeInstanceOf(AuthError);
        await expect(
            verifyPassword("x", "scrypt$nope$0$0$abc$def"),
        ).rejects.toMatchObject({ code: "MALFORMED_HASH" });
        await expect(
            verifyPassword("x", `scrypt$${4}$${0}$${1}$${"AAAA"}$${"AAAA"}`),
        ).rejects.toMatchObject({ code: "MALFORMED_HASH" });
    });
});

describe("generateDeviceToken / hashDeviceToken", () => {
    it("issues a base64url token with a matching 8-char prefix", () => {
        const material = generateDeviceToken();
        expect(material.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(material.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(material.prefix).toHaveLength(8);
        expect(material.token.startsWith(material.prefix)).toBe(true);
    });

    it("issues distinct tokens per call", () => {
        expect(generateDeviceToken().token).not.toBe(
            generateDeviceToken().token,
        );
    });

    it("hashes deterministically into the store's form", () => {
        const material = generateDeviceToken();
        expect(hashDeviceToken(material.token)).toBe(material.tokenHash);
    });
});
