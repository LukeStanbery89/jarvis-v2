/**
 * Auth error type.
 *
 * Every failure rootable to account/device/session handling throws an
 * {@link AuthError}. The `code` is a stable machine-readable discriminator
 * (routes map it to status codes); the `message` is safe to surface to users
 * via REST/WS error frames.
 */
export type AuthErrorCode =
    | "USERNAME_TAKEN"
    | "INVALID_CREDENTIALS"
    | "OWNER_EXISTS"
    | "BOOTSTRAP_DISABLED"
    | "BAD_BOOTSTRAP_TOKEN"
    | "RATE_LIMITED"
    | "NOT_FOUND"
    | "NOT_AUTHORIZED"
    | "BAD_REQUEST"
    | "MALFORMED_HASH";

export class AuthError extends Error {
    readonly code: AuthErrorCode;

    constructor(code: AuthErrorCode, message: string) {
        super(message);
        this.name = "AuthError";
        this.code = code;
    }
}
