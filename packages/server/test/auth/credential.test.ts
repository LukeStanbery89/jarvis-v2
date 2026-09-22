import { describe, expect, it, vi } from "vitest";
import { createCredentialVerifier } from "../../src/auth";
import * as crypto from "../../src/auth/crypto";

describe("CredentialVerifier", () => {
    it("hashes a password and verifies it (correct vs wrong)", async () => {
        const verifier = createCredentialVerifier();
        const hash = await verifier.hash("hunter2");
        expect(hash.startsWith("scrypt$")).toBe(true);
        await expect(verifier.verify("hunter2", hash)).resolves.toBe(true);
        await expect(verifier.verify("wrong", hash)).resolves.toBe(false);
    });

    it("returns false for an unknown username (null stored hash)", async () => {
        const verifier = createCredentialVerifier();
        await expect(verifier.verify("hunter2", null)).resolves.toBe(false);
    });

    it("isolates the dummy-hash cache per verifier instance", async () => {
        const spy = vi.spyOn(crypto, "hashPassword");
        try {
            const a = createCredentialVerifier();
            const b = createCredentialVerifier();
            await a.verify("pw", null);
            await a.verify("pw", null);
            await b.verify("pw", null);
            // Each instance pays its own single cold-start dummy hash; a
            // shared cache would materialize only one.
            expect(spy).toHaveBeenCalledTimes(2);
        } finally {
            spy.mockRestore();
        }
    });

    it("re-throws a malformed stored hash instead of answering false", async () => {
        const verifier = createCredentialVerifier();
        await expect(
            verifier.verify("x", "not-a-scrypt-string"),
        ).rejects.toMatchObject({ code: "MALFORMED_HASH" });
    });
});
