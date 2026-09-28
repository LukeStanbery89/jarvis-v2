/**
 * Browser-side credential storage for the web chat client.
 *
 * The device token obtained from `POST /api/auth/login` is kept in
 * localStorage under per-username keys, mirroring the CLI's credentials-file
 * posture (`~/.jarvis/credentials.json`). Persisting the token is a
 * deliberate product decision — it survives restarts like the CLI, at the
 * accepted cost of being readable by any XSS in the page.
 *
 * Keys (all namespaced per username so several accounts can share a browser
 * without cross-user leaks):
 *
 * - `jarvis.web.activeUser`         — the username whose credential is active
 * - `jarvis.web.user.<name>.token`  — the device token (secret)
 * - `jarvis.web.user.<name>.userId` — the account's user id (sidebar row filter)
 * - `jarvis.web.user.<name>.device` — echo of the issued device (`{id,name,prefix}`)
 * - `jarvis.web.user.<name>.threads`— the transcript store (see `threads.ts`)
 *
 * Sign-out clears the token, device echo, and the active pointer but
 * **keeps** the transcript store — logging back in re-merges conversations.
 *
 * The `Storage` handle is injected so node tests can run without a DOM.
 */

/** Key of the active-username pointer. */
const ACTIVE_KEY = "jarvis.web.activeUser";

/** Namespaced per-user leaf key. */
function userKey(username: string, leaf: string): string {
    return `jarvis.web.user.${username}.${leaf}`;
}

/** The credential the client signs in and reconnects with. */
export interface StoredCredential {
    /** The signed-in account's username. */
    username: string;
    /** The account's user id (used to filter own rows out of owner listings). */
    userId: number;
    /** The device token — a secret, never logged. */
    token: string;
    /** Echo of the issued device (display only; the token itself is one-time). */
    device: { id: number; name: string; prefix: string };
}

/**
 * Persists a credential and marks its username active. Call after a
 * successful `POST /api/auth/login`.
 */
export function saveCredential(
    storage: Storage,
    credential: StoredCredential,
): void {
    storage.setItem(userKey(credential.username, "token"), credential.token);
    storage.setItem(
        userKey(credential.username, "userId"),
        String(credential.userId),
    );
    storage.setItem(
        userKey(credential.username, "device"),
        JSON.stringify(credential.device),
    );
    storage.setItem(ACTIVE_KEY, credential.username);
}

/**
 * Loads the active credential, or `null` when absent/corrupt. `userId` is
 * recovered from the device echo's sibling key written at login time —
 * older entries without one are treated as absent.
 */
export function loadCredential(storage: Storage): StoredCredential | null {
    const username = storage.getItem(ACTIVE_KEY);
    if (!username) {
        return null;
    }
    const token = storage.getItem(userKey(username, "token"));
    const userIdRaw = storage.getItem(userKey(username, "userId"));
    const deviceRaw = storage.getItem(userKey(username, "device"));
    if (!token || !deviceRaw || userIdRaw === null) {
        return null;
    }
    try {
        const userId = Number(userIdRaw);
        const device = JSON.parse(deviceRaw) as StoredCredential["device"];
        if (!Number.isInteger(userId) || typeof device?.id !== "number") {
            return null;
        }
        return { username, userId, token, device };
    } catch {
        return null;
    }
}

/**
 * Clears the active credential: the user's token + device echo + userId and
 * the active-username pointer. The transcript store is deliberately kept —
 * logging back in re-merges conversations.
 */
export function clearCredential(storage: Storage): void {
    const username = storage.getItem(ACTIVE_KEY);
    if (username) {
        storage.removeItem(userKey(username, "token"));
        storage.removeItem(userKey(username, "device"));
        storage.removeItem(userKey(username, "userId"));
    }
    storage.removeItem(ACTIVE_KEY);
}
