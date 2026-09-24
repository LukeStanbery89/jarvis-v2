/**
 * Auth core package.
 *
 * The single home for accounts, device credentials, and the app database
 * (users/devices/sessions/prefs). The server's REST middleware (`requireAuth`
 * etc.) and the WS handshake resolve tokens through these seams; see the
 * package `README.md` for the module guide.
 */
export { AuthError } from "./errors";
export type { AuthErrorCode } from "./errors";
export { generateDeviceToken, hashDeviceToken } from "./crypto";
export type { DeviceTokenMaterial } from "./crypto";
export { createCredentialVerifier } from "./credential";
export type { CredentialVerifier } from "./credential";
export { canManage, ownsRow } from "./ownership";
export {
    ensurePrivateDir,
    ensurePrivateFile,
    ensurePrivateStorage,
} from "./fs";
export { openAppDatabase, SqliteAppDatabase } from "./store";
export type {
    AppDatabase,
    DeviceLedger,
    SessionLedger,
    UserLedger,
} from "./store";
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
