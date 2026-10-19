/**
 * Account preferences for the settings panel (`GET`/`PUT /api/prefs`).
 *
 * Plain React state over the pure helpers in `prefs.ts`, the same shape as
 * `useNotifications`: one read on mount, an optimistic write, and an honest
 * answer when the write fails.
 *
 * Two deliberate rules:
 *
 * - **The server's answer is the truth.** Every successful call replaces the
 *   local map with the body the server returned, so the panel renders what is
 *   stored rather than what we hoped to store.
 * - **A rejected write is answered by re-reading, not by guessing.** The panel
 *   is optimistic while a write is in flight; if it fails, this re-reads the
 *   map instead of trying to undo the change by hand. A rollback computed
 *   locally would have to know which keys another writer touched in the
 *   meantime, and "ask the server what it actually has" cannot get that wrong.
 *
 * The token is the component's device credential; a 401 is the app's problem
 * (it drops to login), so it is not surfaced as a settings error.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Prefs } from "../api";
import { debugLog } from "../debug";

/** What {@link usePrefs} exposes to the view. */
export interface PrefsState {
    /** The stored map (empty until the first read lands). */
    prefs: Prefs;
    /** Whether the first read has completed — the panel waits for it. */
    loaded: boolean;
    /** A write is in flight. */
    saving: boolean;
    /** Why the last read or write failed, if it did. */
    error: string | null;
    /** Writes the given keys; only those keys are touched on the server. */
    patch(patch: Prefs): void;
    /** Re-reads the map (also the recovery path after a failed write). */
    reload(): void;
}

/**
 * Owns the signed-in account's preferences map.
 *
 * @param token - The device credential the REST calls authenticate with.
 */
export function usePrefs(options: { token: string }): PrefsState {
    const { token } = options;
    const [prefs, setPrefsState] = useState<Prefs>({});
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /**
     * The latest map, read by `patch` — a patch must see the values stored
     * before it, and a `useCallback` dependency on `prefs` would rebuild the
     * callback on every write for no reason.
     */
    const prefsRef = useRef<Prefs>(prefs);
    const setPrefs = useCallback((next: Prefs) => {
        prefsRef.current = next;
        setPrefsState(next);
    }, []);

    const reload = useCallback(() => {
        api.getPrefs(token)
            .then((map) => {
                setPrefs(map);
                setLoaded(true);
                setError(null);
                debugLog("prefs", `loaded ${Object.keys(map).length} key(s)`);
            })
            .catch((err: unknown) => {
                if (err instanceof ApiError && err.status === 401) {
                    return;
                }
                setError(messageFor(err, "could not load your settings"));
            });
    }, [setPrefs, token]);

    useEffect(() => {
        reload();
    }, [reload]);

    const patch = useCallback(
        (next: Prefs) => {
            // Optimistic: the control follows the click immediately, and the
            // server's response replaces this either way.
            setPrefs({ ...prefsRef.current, ...next });
            setSaving(true);
            setError(null);
            debugLog("prefs", `write ${Object.keys(next).join(", ")}`);
            api.setPrefs(token, next)
                .then((map) => setPrefs(map))
                .catch((err: unknown) => {
                    if (err instanceof ApiError && err.status === 401) {
                        return;
                    }
                    setError(messageFor(err, "could not save that setting"));
                    reload();
                })
                .finally(() => setSaving(false));
        },
        [reload, setPrefs, token],
    );

    return { prefs, loaded, saving, error, patch, reload };
}

/** The server's own wording when it sent one, else a plain fallback. */
function messageFor(err: unknown, fallback: string): string {
    return err instanceof Error && err.message.length > 0
        ? err.message
        : fallback;
}
