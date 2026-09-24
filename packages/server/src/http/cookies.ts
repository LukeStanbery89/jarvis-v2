/**
 * Hand-rolled session-cookie helpers for the web portal (#24).
 *
 * No `cookie-parser`/`express-session` dependency: the API surface here is
 * exactly what the `/api` router needs to read a presented token, set the
 * session cookie after login, and clear it on logout. The token itself is
 * opaque — generated and verified by `@lukestanbery/jarvis-auth`'s
 * `CookieSessionProvider`; this module only moves it across the wire.
 *
 * Cookie attributes are fixed (see `setSessionCookie`): HttpOnly, Strict
 * SameSite, Path=/, absolute Max-Age. Under TLS the name gains the `__Host-`
 * prefix (which the browser enforces requires `Secure` + `Path=/`) and the
 * `Secure` flag is added; on plain HTTP the plain name is used without
 * `Secure`, since a `__Host-` cookie would be rejected by any browser.
 */
import type { Response } from "express";

/** Base cookie name; `__Host-` is prepended when the server speaks TLS. */
export const SESSION_COOKIE_NAME = "jarvis_session";

/** The cookie name actually used, chosen by the TLS mode of the listener. */
export function sessionCookieName(secure: boolean): string {
    return secure ? `__Host-${SESSION_COOKIE_NAME}` : SESSION_COOKIE_NAME;
}

/**
 * Parses a raw `Cookie` header into a map.
 *
 * Handles the `name=value; name2=value2` shape Node/Express exposes; escapes
 * are not decoded because the session token is deliberately restricted to
 * base64url characters, and any other field is read with its raw value.
 */
export function parseCookies(
    header: string | undefined,
): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) {
        return out;
    }
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx === -1) {
            continue;
        }
        const name = part.slice(0, idx).trim();
        if (name.length > 0) {
            out[name] = part.slice(idx + 1).trim();
        }
    }
    return out;
}

/** Reads the session token from a request's cookies, if present and non-empty. */
export function readSessionToken(
    req: { headers: { cookie?: string } },
    secure: boolean,
): string | null {
    const token = parseCookies(req.headers.cookie)[sessionCookieName(secure)];
    return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * Sets the session cookie. Attributes: `HttpOnly` + `SameSite=Strict` +
 * `Path=/` always; `Secure` and the `__Host-` name prefix only when `secure`.
 * `maxAgeSeconds` comes from the provider's `expiresAt - now`.
 */
export function setSessionCookie(
    res: Response,
    token: string,
    maxAgeSeconds: number,
    secure: boolean,
): void {
    const parts = [
        `${sessionCookieName(secure)}=${token}`,
        "HttpOnly",
        "SameSite=Strict",
        "Path=/",
        `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ];
    if (secure) {
        parts.push("Secure");
    }
    res.setHeader("Set-Cookie", parts.join("; "));
}

/** Expires the session cookie on the client (logout). */
export function clearSessionCookie(res: Response, secure: boolean): void {
    setSessionCookie(res, "", 0, secure);
}
