/**
 * Server auth module.
 *
 * The single home for accounts, device credentials, and the app database
 * (users/devices/sessions/prefs). The REST middleware (`requireAuth` etc.)
 * and the WS handshake resolve tokens through these seams; see the `README.md`
 * in this directory for the module guide.
 */
export { AuthError } from "./errors";
export type { AuthErrorCode } from "./errors";
export {
    DEFAULT_SCRYPT_PARAMS,
    FAST_SCRYPT_PARAMS,
    generateDeviceToken,
    hashDeviceToken,
    hashPassword,
    verifyDeviceToken,
    verifyPassword,
} from "./crypto";
export type { DeviceTokenMaterial, ScryptParams } from "./crypto";
export { openAppStore, SqliteAppStore } from "./store";
export type { AppStore } from "./store";
export type {
    AppDevice,
    AppSession,
    AppUser,
    AuthContext,
    ResolvedIdentity,
    Role,
    SessionKind,
} from "./types";
