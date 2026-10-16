/**
 * The settings panel: the account's notification preferences beside the
 * settings that only exist in this browser.
 *
 * The two groups are the point of the surface, not decoration. A setting the
 * *server* applies (whether to interrupt you, and when) has to hold on every
 * device, while a setting the *browser* owns (its notification permission, a
 * microphone, a location) cannot be synced without lying — so the panel says
 * which is which rather than presenting one flat list of switches.
 *
 * Presentational, like `Sidebar.tsx`: state comes in as props, changes go out
 * as callbacks. The one exception is the quiet-hours fields, which are a draft
 * until they are saved (an `<input type="time">` is edited a segment at a time,
 * so writing on every keystroke would send half-typed windows) — the same
 * reason `Composer.tsx` owns its draft.
 *
 * Rendering follows the system's *effective* behaviour. A stored preference the
 * server could not parse is shown as what actually happens ("not in effect"),
 * with a line saying so, and never as a crash, as raw bytes, or silently as the
 * default: the last of those would hide a write that went wrong, which is the
 * failure class these preferences exist to remove.
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { describeLocationState, type LocationUiState } from "../../location";
import { describeWakeState } from "../../sidebar";
import {
    DEFAULT_QUIET_HOURS,
    notificationsEnabledPatch,
    quietHoursEdit,
    quietHoursPatch,
    readNotificationsEnabled,
    readQuietHours,
    type QuietHours,
} from "../../prefs";
import type { Prefs } from "../../api";

/** Props for {@link Settings}. */
export interface SettingsProps {
    /** Whether the panel is showing. */
    open: boolean;
    /** Closes the panel (the dialog's own close, its button, or Escape). */
    onClose(): void;

    /* Your account — server preferences (`/api/prefs`). */
    /** The stored preferences map. */
    prefs: Prefs;
    /** Whether the first read has landed (the group waits for it). */
    prefsLoaded: boolean;
    /** A write is in flight. */
    prefsSaving: boolean;
    /** Why the last read or write failed, if it did. */
    prefsError: string | null;
    /** Writes the given keys. */
    onPatchPrefs(patch: Prefs): void;

    /* This browser — per-device settings, stored locally. */
    /** This browser can raise OS notifications at all. */
    browserNotifyAvailable: boolean;
    /** The OS-notification preference for this browser. */
    browserNotifyOn: boolean;
    /** Its label/tooltip (from `describeBrowserNotifyState`). */
    browserNotifyLabel: string;
    /** Flips the OS-notification preference (prompting for permission). */
    onToggleBrowserNotify(): void;
    /** Local wake engines exist and the server serves the model. */
    wakeAvailable: boolean;
    /** The wake-word preference. */
    wakeOn: boolean;
    /** The controller is actively listening for the wake phrase. */
    wakeArmed: boolean;
    /** Flips the wake-word toggle. */
    onToggleWake(): void;
    /** The location-sharing preference. */
    locationOn: boolean;
    /** Why the location pin looks the way it does. */
    locationState: LocationUiState;
    /** Flips location sharing. */
    onToggleLocation(): void;

    /** Signs out of this browser. */
    onSignOut(): void;
}

/**
 * The settings panel, as a native modal dialog.
 *
 * `<dialog showModal()>` is doing real work here: Escape-to-close, keeping
 * focus inside the panel while it is open, and restoring focus to the gear on
 * close are the platform's job, not a hand-rolled key handler's — and a trap
 * written by hand is the part of a dialog that usually rots.
 *
 * @param props - See {@link SettingsProps}.
 */
export function Settings(props: SettingsProps) {
    const {
        open,
        onClose,
        prefs,
        prefsLoaded,
        prefsSaving,
        prefsError,
        onPatchPrefs,
        browserNotifyAvailable,
        browserNotifyOn,
        browserNotifyLabel,
        onToggleBrowserNotify,
        wakeAvailable,
        wakeOn,
        wakeArmed,
        onToggleWake,
        locationOn,
        locationState,
        onToggleLocation,
        onSignOut,
    } = props;

    const dialogRef = useRef<HTMLDialogElement | null>(null);
    /** The window being typed, or `null` while nothing is mid-edit. */
    const [draft, setDraft] = useState<QuietHours | null>(null);
    /** Why the typed window cannot be saved. */
    const [windowError, setWindowError] = useState<string | null>(null);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (dialog === null) {
            return;
        }
        if (open && !dialog.open) {
            dialog.showModal();
        } else if (!open && dialog.open) {
            dialog.close();
        }
    }, [open]);

    const enabled = readNotificationsEnabled(prefs);
    const quiet = readQuietHours(prefs);
    /** What the fields show when nothing is mid-edit. */
    const stored = quiet.value ?? DEFAULT_QUIET_HOURS;
    const window = draft ?? stored;

    /**
     * A landed save (or another device's change) is the new truth, so the
     * draft is dropped and the fields show what is stored. A *failed* save
     * leaves the stored value alone, which keeps the draft — with the error
     * beside it — rather than reverting under the user's hands.
     */
    useEffect(() => {
        setDraft(null);
    }, [stored.start, stored.end, quiet.unreadable]);

    /** Switches quiet hours on (with the shown window) or off (`null`). */
    function toggleQuietHours(on: boolean): void {
        setDraft(null);
        setWindowError(null);
        onPatchPrefs(quietHoursPatch(on ? stored : null));
    }

    /** Saves the typed window once the field loses focus. */
    function commitWindow(): void {
        if (draft === null) {
            return;
        }
        const edit = quietHoursEdit(draft.start, draft.end);
        if (edit.kind === "invalid") {
            setWindowError(edit.message);
            return;
        }
        setWindowError(null);
        onPatchPrefs(edit.patch);
    }

    const accountDisabled = !prefsLoaded || prefsSaving;
    const quietOn = quiet.value !== null;

    return (
        <dialog
            ref={dialogRef}
            id="settings-panel"
            className="settings"
            aria-labelledby="settings-title"
            onClose={onClose}
        >
            <div className="settings-head">
                <h2 id="settings-title">Settings</h2>
                <button
                    type="button"
                    className="icon-btn small"
                    aria-label="Close settings"
                    title="Close settings"
                    onClick={() => dialogRef.current?.close()}
                >
                    <X size={16} aria-hidden="true" />
                </button>
            </div>

            <section className="settings-group">
                <h3>Your account</h3>
                <p className="settings-hint">
                    Applies everywhere you sign in with this account.
                </p>
                {!prefsLoaded ? (
                    <p className="settings-note" role="status">
                        Loading your settings…
                    </p>
                ) : (
                    <>
                        <label className="settings-row">
                            <input
                                type="checkbox"
                                checked={enabled.value}
                                disabled={accountDisabled}
                                onChange={(event) =>
                                    onPatchPrefs(
                                        notificationsEnabledPatch(
                                            event.target.checked,
                                        ),
                                    )
                                }
                            />
                            <span>Notifications</span>
                        </label>
                        {enabled.unreadable && (
                            <p className="settings-warning" role="status">
                                A value is stored here that JARVIS cannot read,
                                so notifications are on by default — toggle this
                                switch either way to replace it.
                            </p>
                        )}

                        <label className="settings-row">
                            <input
                                type="checkbox"
                                checked={quietOn}
                                disabled={accountDisabled}
                                onChange={(event) =>
                                    toggleQuietHours(event.target.checked)
                                }
                            />
                            <span>Quiet hours</span>
                        </label>
                        <div className="settings-times">
                            <input
                                type="time"
                                aria-label="Quiet hours start"
                                value={window.start}
                                disabled={accountDisabled || !quietOn}
                                onChange={(event) =>
                                    setDraft({
                                        ...window,
                                        start: event.target.value,
                                    })
                                }
                                onBlur={commitWindow}
                            />
                            <span aria-hidden="true">→</span>
                            <input
                                type="time"
                                aria-label="Quiet hours end"
                                value={window.end}
                                disabled={accountDisabled || !quietOn}
                                onChange={(event) =>
                                    setDraft({
                                        ...window,
                                        end: event.target.value,
                                    })
                                }
                                onBlur={commitWindow}
                            />
                        </div>
                        {quiet.unreadable && (
                            <p className="settings-warning" role="status">
                                A value is stored here that JARVIS cannot read,
                                so quiet hours are not in effect — pick a window
                                to replace it.
                            </p>
                        )}
                        {quietOn && (
                            <p className="settings-note">
                                {`${window.start} → ${window.end}`}
                                {enabled.value
                                    ? " — low and normal priorities wait until it ends"
                                    : " — nothing is pushed anyway while notifications are off"}
                            </p>
                        )}
                        {windowError !== null && (
                            <p className="settings-error" role="alert">
                                {windowError}
                            </p>
                        )}
                    </>
                )}
                {prefsError !== null && (
                    <p className="settings-error" role="alert">
                        {prefsError}
                    </p>
                )}
                {prefsSaving && (
                    <p className="settings-note" role="status">
                        Saving…
                    </p>
                )}
            </section>

            <section className="settings-group">
                <h3>This browser</h3>
                <p className="settings-hint">
                    Stored in this browser only — signing in elsewhere does not
                    carry these over.
                </p>

                <label className="settings-row">
                    <input
                        type="checkbox"
                        checked={browserNotifyOn}
                        disabled={!browserNotifyAvailable}
                        onChange={onToggleBrowserNotify}
                    />
                    <span>Desktop notifications</span>
                </label>
                <p className="settings-note">{browserNotifyLabel}</p>

                <label className="settings-row">
                    <input
                        type="checkbox"
                        checked={wakeOn}
                        disabled={!wakeAvailable}
                        onChange={onToggleWake}
                    />
                    <span>Wake word</span>
                </label>
                <p className="settings-note">
                    {describeWakeState(wakeAvailable, wakeArmed)}
                </p>

                <label className="settings-row">
                    <input
                        type="checkbox"
                        checked={locationOn}
                        onChange={onToggleLocation}
                    />
                    <span>Share location</span>
                </label>
                <p
                    className={
                        locationOn && locationState !== "active"
                            ? "settings-warning"
                            : "settings-note"
                    }
                    role="status"
                >
                    {describeLocationState(locationState)}
                </p>
            </section>

            <div className="settings-group settings-actions">
                <button
                    type="button"
                    className="settings-signout"
                    onClick={onSignOut}
                >
                    Sign out
                </button>
            </div>
        </dialog>
    );
}
