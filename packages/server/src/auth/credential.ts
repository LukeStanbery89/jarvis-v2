/**
 * Credential seam: password hashing + verification, including the
 * timing-equalization dummy hash.
 *
 * The REST layer depends on this interface instead of scrypt directly —
 * `authRoutes.ts` never imports `crypto.ts` — so the credential mechanism is
 * swappable: a future biometric credential (issue #25) implements the same
 * shape, and tests can substitute a fake. The default implementation wraps
 * `crypto.ts` at `DEFAULT_SCRYPT_PARAMS`.
 */
import { hashPassword, verifyPassword } from "./crypto";

/** A password never used for storage; only its scrypt *cost* matters. */
const DUMMY_PASSWORD = "definitely-not-a-real-password";

/**
 * Interface the credential endpoints code against.
 *
 * `hash` produces the stored form of a new/changed password (bootstrap,
 * `POST /api/users`); `verify` checks a presented password against a stored
 * hash. A `null` hash (an unknown username — there is no row) must cost the
 * same scrypt as a real one so usernames can't be enumerated by response
 * time; that equalization lives here, not in the route handler.
 */
export interface CredentialVerifier {
    /** scrypt-hashes a plaintext password into its stored `scrypt$…` form. */
    hash(plaintext: string): Promise<string>;
    /**
     * Constant-time check of `password` against a stored hash. An unknown
     * username (`storedHash === null`) verifies against a cached dummy hash at
     * the same cost; the result is `false` either way.
     */
    verify(password: string, storedHash: string | null): Promise<boolean>;
}

/**
 * Builds the default scrypt-backed {@link CredentialVerifier}.
 *
 * The dummy hash is cached per verifier instance (one per router), so the
 * anti-enumeration scrypt cost materializes once and is reused thereafter.
 */
export function createCredentialVerifier(): CredentialVerifier {
    let dummyCache: Promise<string> | null = null;
    return {
        hash: (plaintext: string) => hashPassword(plaintext),
        async verify(password: string, storedHash: string | null) {
            if (storedHash === null) {
                // Two simultaneous cold-start attempts may both begin a dummy
                // hash and one is discarded — a one-time, per-instance cost
                // (the same shape as the old module-scope cache race).
                dummyCache ??= hashPassword(DUMMY_PASSWORD);
                storedHash = await dummyCache;
            }
            return verifyPassword(password, storedHash);
        },
    };
}
