/**
 * Known preference keys and their write validation (#143).
 *
 * `/api/prefs` is a free-form map on purpose: integrations own their own keys,
 * and the portal's raw JSON editor is the escape hatch for them. But a key that
 * a *feature* reads deserves more than a shrug — if `notify.quietHours` is
 * written in a shape the delivery path cannot parse, the setting appears to
 * save and then silently does nothing, which is exactly the "nothing happened"
 * class #139 exists to remove.
 *
 * So writes to a known key are validated here and a malformed value is a 400 to
 * whoever wrote it — the web panel, the portal's raw editor, or `curl`. A
 * setting that cannot work now fails loudly at the moment it is set, instead of
 * quietly at the moment it should have fired.
 *
 * Unknown keys stay free-form and untouched: this registry grows one entry per
 * feature that *reads* a pref, not one entry per pref that exists. The
 * validators themselves live with the feature that owns the key (see
 * `../notify/prefs.ts`), so the reader and the writer keep one definition.
 */
import { AuthError } from "@lukestanbery/jarvis-auth";
import {
    NOTIFY_ENABLED_PREF,
    NOTIFY_QUIET_HOURS_PREF,
    validateEnabledPref,
    validateQuietHoursPref,
} from "../notify/prefs";

/**
 * Checks one value for one key, returning the message to reject it with, or
 * `null` when the value is acceptable.
 */
export type PrefValidator = (value: unknown) => string | null;

/** Every key the server reads, and the check its writes must pass. */
const KNOWN_PREFS: ReadonlyMap<string, PrefValidator> = new Map([
    [NOTIFY_ENABLED_PREF, validateEnabledPref],
    [NOTIFY_QUIET_HOURS_PREF, validateQuietHoursPref],
]);

/**
 * Rejects a malformed value for any *known* key; unknown keys pass through.
 *
 * Called by the prefs routes after a body has been shaped into entries and
 * before it is stored, so a rejected write leaves the account's prefs exactly
 * as they were.
 */
export function assertKnownPrefs(
    entries: { key: string; value: unknown }[],
): void {
    for (const { key, value } of entries) {
        const validate = KNOWN_PREFS.get(key);
        if (validate === undefined) {
            continue;
        }
        const reason = validate(value);
        if (reason !== null) {
            throw new AuthError("BAD_REQUEST", reason);
        }
    }
}
