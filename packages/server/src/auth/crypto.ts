/**
 * Password + device-token cryptography.
 *
 * Passwords are hashed with node's built-in `crypto.scrypt` (no third-party
 * deps) into self-describing `scrypt$N$r$p$salt$key` strings so parameters
 * ride along with the stored hash and can be raised later without a
 * migration. Device tokens are 32 random bytes that must be shown to the
 * server only over the wire — only their SHA-256 hash and an 8-char display
 * prefix are ever persisted.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AuthError } from "./errors";

/** scrypt cost parameters; encoded into the stored hash string. */
export interface ScryptParams {
    /** Memory/cpu cost; must be a power of two > 1. */
    N: number;
    /** Block size. */
    r: number;
    /** Parallelization factor. */
    p: number;
}

/** Baseline scrypt cost for a household server (roughly 50-100ms hashing). */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

const SALT_LENGTH = 16;
const PASSWORD_KEY_LENGTH = 64;
const TOKEN_BYTES = 32;
const TOKEN_PREFIX_LENGTH = 8;

/** Promisified `crypto.scrypt`, typed against the options we pass. */
function scryptAsync(
    password: string,
    salt: Buffer,
    keylen: number,
    options: { N: number; r: number; p: number },
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, keylen, options, (err, key) => {
            if (err) {
                reject(err);
            } else {
                resolve(key);
            }
        });
    });
}

/**
 * Hashes a password into a self-describing `scrypt$N$r$p$salt$key` string.
 */
export async function hashPassword(
    password: string,
    params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const key = await scryptAsync(password, salt, PASSWORD_KEY_LENGTH, params);
    return [
        "scrypt",
        params.N,
        params.r,
        params.p,
        salt.toString("base64url"),
        key.toString("base64url"),
    ].join("$");
}

/**
 * Checks a password against a stored `scrypt$…` hash.
 *
 * Returns `false` on mismatch; throws {@link AuthError} if the stored hash is
 * malformed (a corrupted store, not a wrong guess).
 */
export async function verifyPassword(
    password: string,
    encoded: string,
): Promise<boolean> {
    const parts = encoded.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") {
        throw new AuthError(
            "MALFORMED_HASH",
            "stored password hash is malformed",
        );
    }
    const [, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts;
    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (
        !Number.isFinite(N) ||
        !Number.isFinite(r) ||
        !Number.isFinite(p) ||
        N <= 1 ||
        r < 1 ||
        p < 1
    ) {
        throw new AuthError(
            "MALFORMED_HASH",
            "stored password hash is malformed",
        );
    }
    const salt = Buffer.from(saltRaw, "base64url");
    const expected = Buffer.from(keyRaw, "base64url");
    const actual = await scryptAsync(password, salt, expected.length, {
        N,
        r,
        p,
    });
    return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
    );
}

/** Material for a freshly issued device token. */
export interface DeviceTokenMaterial {
    /** The secret the client must present over the wire; never persisted. */
    token: string;
    /** SHA-256 hex of `token`: what the store persists. */
    tokenHash: string;
    /** Short display prefix for listing devices without exposing the token. */
    prefix: string;
}

/** Generates a 32-byte base64url device token plus its stored + display forms. */
export function generateDeviceToken(): DeviceTokenMaterial {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    return {
        token,
        tokenHash: hashDeviceToken(token),
        prefix: token.slice(0, TOKEN_PREFIX_LENGTH),
    };
}

/** SHA-256 hex of a device token (the only form stored at rest). */
export function hashDeviceToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/** Constant-time check of a presented token against a stored token hash. */
export function verifyDeviceToken(token: string, secretHash: string): boolean {
    const actual = Buffer.from(hashDeviceToken(token), "hex");
    const expected = Buffer.from(secretHash, "hex");
    return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
    );
}
