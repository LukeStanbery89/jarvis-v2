/**
 * The browser/OS notification channel (#139 phase 2): the imperative half.
 *
 * Everything that needed deciding lives in `browserNotify.ts`; what is left
 * here is the DOM work — feature detection, the permission prompt (which a
 * browser only honours inside a user gesture, so it happens in the toggle's
 * click handler rather than in an effect), and raising one `Notification` per
 * newly-arrived notification while the tab is hidden.
 *
 * Two details that are easy to get wrong and are deliberate here:
 *
 * - **Announcements are tracked by id, not by list position.** The live frame
 *   and the fetched page both mention the same notification, and the list
 *   re-renders on every settle — so "did we already pop this up?" has to be a
 *   set of ids, or a refresh would re-announce everything.
 * - **A click focuses this tab and marks the notification read.** That is the
 *   whole point of the OS channel: it is how the user gets back to the
 *   notification. Focusing is best-effort (browsers gate `window.focus()` on
 *   the notification click path, which is exactly where this runs).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
    browserNotifyState,
    describeBrowserNotifyState,
    loadBrowserNotifyPref,
    notificationBody,
    saveBrowserNotifyPref,
    shouldAnnounce,
} from "../browserNotify";
import type { BrowserNotifyUiState } from "../browserNotify";
import type { ClientNotification } from "../notifications";

/** What {@link useBrowserNotify} exposes to the view. */
export interface BrowserNotifyState {
    /** Whether this browser can raise OS notifications at all. */
    available: boolean;
    /** The user's stored preference for this browser. */
    enabled: boolean;
    /** The label/tooltip for the toggle. */
    label: string;
    /** The derived UI state (drives the toggle's appearance). */
    state: BrowserNotifyUiState;
    /** Flips the preference, prompting for permission on the way on. */
    toggle(): void;
}

/**
 * Owns the OS-notification preference and announcements.
 *
 * @param username - Whose preference to read/write (per-browser, per-user).
 * @param notifications - The merged list (phase 1) to watch for new arrivals.
 * @param onOpen - Called when the user clicks an OS notification.
 */
export function useBrowserNotify(options: {
    username: string;
    notifications: ClientNotification[];
    onOpen(id: string): void;
}): BrowserNotifyState {
    const { username, notifications, onOpen } = options;
    const supported = supportsNotifications();
    const [enabled, setEnabled] = useState(false);
    const [permission, setPermission] = useState<string>(() =>
        supported ? Notification.permission : "denied",
    );
    /** Ids already popped up this session (see the module doc). */
    const announced = useRef<Set<string>>(new Set());
    /** Latest `onOpen`, so the announcement effect needs no re-subscription. */
    const onOpenRef = useRef(onOpen);
    onOpenRef.current = onOpen;

    // Read the stored preference once per user: a switch of account on the
    // same browser must not inherit the previous user's choice.
    useEffect(() => {
        setEnabled(
            supported && typeof localStorage !== "undefined"
                ? loadBrowserNotifyPref(localStorage, username)
                : false,
        );
    }, [supported, username]);

    const toggle = useCallback(() => {
        if (!supported) {
            return;
        }
        // Turning it off is immediate: permission is the browser's business,
        // and we never ask for it to be revoked.
        if (enabled) {
            setEnabled(false);
            if (typeof localStorage !== "undefined") {
                saveBrowserNotifyPref(localStorage, username, false);
            }
            return;
        }
        // Turning it on needs permission, and `requestPermission` only
        // prompts from a user gesture — this callback is that gesture.
        if (Notification.permission === "granted") {
            setEnabled(true);
            saveBrowserNotifyPref(localStorage, username, true);
            return;
        }
        if (Notification.permission === "denied") {
            // Cannot be re-prompted; the tooltip points at browser settings.
            return;
        }
        void Notification.requestPermission().then((result) => {
            setPermission(result);
            if (result === "granted") {
                setEnabled(true);
                saveBrowserNotifyPref(localStorage, username, true);
            }
        });
    }, [enabled, supported, username]);

    useEffect(() => {
        if (!supported || !enabled) {
            return;
        }
        for (const notification of notifications) {
            const announce = shouldAnnounce(notification, {
                enabled,
                permission,
                hidden:
                    typeof document === "undefined" ||
                    document.visibilityState === "hidden",
                announced: announced.current,
            });
            if (!announce) {
                continue;
            }
            announced.current.add(notification.id);
            raise(notification, () => onOpenRef.current(notification.id));
        }
    }, [enabled, notifications, permission, supported]);

    const state = browserNotifyState(supported, permission, enabled);
    return {
        available: supported,
        enabled: state === "on",
        label: describeBrowserNotifyState(state),
        state,
        toggle,
    };
}

/**
 * Whether this environment has the Notification API.
 *
 * Guarded rather than assumed: the hook runs in the browser, but the same
 * module graph is imported by node tests, where `Notification` does not exist.
 */
function supportsNotifications(): boolean {
    return typeof Notification !== "undefined";
}

/**
 * Raises one OS notification.
 *
 * iOS Safari throws for a page that is not an installed PWA, and some
 * browsers throw when the notification is raised from a background tab after
 * permission was revoked — neither is worth surfacing to the user, so a
 * failure here is silent: the in-app notification is already on screen when
 * they come back, and the record is the durable half either way.
 */
function raise(notification: ClientNotification, onClick: () => void): void {
    try {
        const raised = new Notification(notification.title, {
            body: notificationBody(notification),
            // A `tag` collapses same-id duplicates (the default is already to
            // replace silently rather than re-alert), which is the safety net
            // behind the announced-ids set.
            tag: notification.id,
        });
        raised.onclick = () => {
            onClick();
            try {
                window.focus();
            } catch {
                // Focusing is a courtesy; the click still marks it read.
            }
            raised.close();
        };
    } catch {
        // See above: best-effort, never fatal.
    }
}
