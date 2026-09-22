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
export { generateDeviceToken, hashDeviceToken } from "./crypto";
export type { DeviceTokenMaterial } from "./crypto";
export { createCredentialVerifier } from "./credential";
export type { CredentialVerifier } from "./credential";
export { canManage, ownsRow } from "./ownership";
export { openAppDatabase, SqliteAppDatabase } from "./store";
export type { AppDatabase } from "./store";
export type {
    AppDevice,
    AppSession,
    AppUser,
    AuthContext,
    AuthenticatedContext,
    GuestContext,
    ResolvedIdentity,
    Role,
    SessionKind,
} from "./types";
