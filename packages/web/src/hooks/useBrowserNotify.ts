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
    notificationOptions,
    saveBrowserNotifyPref,
    shouldAnnounce,
} from "../browserNotify";
import type { BrowserNotifyUiState } from "../browserNotify";
import type { ClientNotification } from "../notifications";
import { debugLog } from "../debug";
import {
    ensurePushSubscription,
    pushSupported,
    removePushSubscription,
} from "../push";

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
 * @param token - The device token used to register/remove this browser's Web
 *   Push subscription.
 * @param notifications - The merged list to watch for new arrivals.
 * @param loaded - Whether the first page load has completed.
 * @param masterEnabled - The account's `notify.enabled`: the server's kill
 *   switch outranks the browser's preference, so nothing pops up on behalf of
 *   an account that asked for silence.
 * @param onOpen - Called with the clicked notification, so the caller can treat
 *   a timer as Stop and everything else as "mark read".
 */
export function useBrowserNotify(options: {
    username: string;
    token: string;
    notifications: ClientNotification[];
    /** Whether the first page load has completed (see `useNotifications`). */
    loaded: boolean;
    masterEnabled: boolean;
    onOpen(notification: ClientNotification): void;
}): BrowserNotifyState {
    const { username, token, notifications, loaded, masterEnabled, onOpen } =
        options;
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
    /** Latest rows, for a service-worker click that names only an id. */
    const notificationsRef = useRef(notifications);
    notificationsRef.current = notifications;
    /** Whether the initial page has been folded into `announced`. */
    const seeded = useRef(false);

    // Read the stored preference once per user: a switch of account on the
    // same browser must not inherit the previous user's choice.
    useEffect(() => {
        setEnabled(
            supported && typeof localStorage !== "undefined"
                ? loadBrowserNotifyPref(localStorage, username)
                : false,
        );
    }, [supported, username]);

    // A service-worker notification has no page closure to call back into;
    // `notificationclick` posts the tag (the notification id) here instead.
    useEffect(() => {
        if (
            !supported ||
            typeof navigator === "undefined" ||
            !("serviceWorker" in navigator)
        ) {
            return;
        }
        const onMessage = (event: MessageEvent): void => {
            const data = event.data as
                { type?: unknown; id?: unknown } | null | undefined;
            if (
                data?.type !== "jarvis-notification-click" ||
                typeof data.id !== "string"
            ) {
                return;
            }
            const notification = notificationsRef.current.find(
                (row) => row.id === data.id,
            );
            if (notification !== undefined) {
                onOpenRef.current(notification);
            }
        };
        navigator.serviceWorker.addEventListener("message", onMessage);
        return () => {
            navigator.serviceWorker.removeEventListener("message", onMessage);
        };
    }, [supported]);

    /**
     * Registers the push endpoint on the first gesture after the preference is
     * already on (the usual case for an account that enabled notifications
     * before Web Push existed).
     *
     * The immediate attempt handles the desktop case, where a subscription can
     * be created without a gesture; the pointerdown listener gives WebKit the
     * gesture it insists on if that attempt fails.
     */
    useEffect(() => {
        if (
            !supported ||
            !enabled ||
            permission !== "granted" ||
            !pushSupported()
        ) {
            return;
        }
        void ensurePushSubscription(token);
        const onGesture = (): void => {
            void ensurePushSubscription(token);
        };
        window.addEventListener("pointerdown", onGesture, { once: true });
        return () => {
            window.removeEventListener("pointerdown", onGesture);
        };
    }, [enabled, permission, supported, token]);

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
            // The device token is still live here, so this is the last chance
            // to remove the server-side endpoint before sign-out.
            void removePushSubscription(token);
            return;
        }
        // Turning it on needs permission, and `requestPermission` only
        // prompts from a user gesture — this callback is that gesture.
        if (Notification.permission === "granted") {
            setEnabled(true);
            saveBrowserNotifyPref(localStorage, username, true);
            void ensurePushSubscription(token);
            return;
        }
        if (Notification.permission === "denied") {
            // Cannot be re-prompted; the tooltip points at browser settings.
            return;
        }
        void Notification.requestPermission().then((result) => {
            debugLog("notify", `permission result=${result}`);
            setPermission(result);
            if (result === "granted") {
                setEnabled(true);
                saveBrowserNotifyPref(localStorage, username, true);
                // Still inside the promise of the original click gesture, so
                // WebKit can accept `pushManager.subscribe` here; the app's
                // first-gesture effect is the fallback if it does not.
                void ensurePushSubscription(token);
            }
        });
    }, [enabled, supported, token, username]);

    useEffect(() => {
        if (!supported || !enabled) {
            return;
        }
        if (!loaded) {
            // Nothing to judge yet: until the first page has been read, the
            // list is empty or mid-fetch, and announcing now would either miss
            // the backlog's own notifications or interrupt for all of them.
            return;
        }
        if (!seeded.current) {
            // The first list this session sees is the *backlog* — everything
            // raised while the tab was closed. Those are marked seen, not
            // announced: opening a hidden tab must not fire one OS
            // notification per unread row (#139 phase 2).
            seeded.current = true;
            for (const notification of notifications) {
                announced.current.add(notification.id);
            }
            debugLog(
                "notify",
                `seeded ${notifications.length} existing notification(s) as seen`,
            );
            return;
        }
        const hidden =
            typeof document === "undefined" ||
            document.visibilityState === "hidden";
        debugLog(
            "notify",
            `announce pass: enabled=${enabled} permission=${permission} hidden=${hidden} rows=${notifications.length}`,
        );
        for (const notification of notifications) {
            const announce = shouldAnnounce(notification, {
                enabled,
                masterEnabled,
                permission,
                hidden,
                announced: announced.current,
            });
            if (!announce) {
                continue;
            }
            announced.current.add(notification.id);
            debugLog("notify", `raising OS notification id=${notification.id}`);
            raise(notification, () => onOpenRef.current(notification));
        }
    }, [enabled, masterEnabled, notifications, permission, supported]);

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
        const raised = new Notification(
            notification.title,
            notificationOptions(notification),
        );
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
        // iOS only exposes notifications through a service worker. The page
        // constructor is the desktop path; this fallback is what makes the
        // installed PWA work without changing the caller.
        void raiseWithServiceWorker(notification);
    }
}

/**
 * Shows one notification through the active service worker.
 *
 * `showNotification` is the only notification path on iOS Home Screen web
 * apps. The click is delivered back to the page by the worker's
 * `notificationclick` handler as a `jarvis-notification-click` message tagged
 * with the notification id.
 */
async function raiseWithServiceWorker(
    notification: ClientNotification,
): Promise<void> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        return;
    }
    try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration === undefined) {
            return;
        }
        await registration.showNotification(notification.title, {
            ...notificationOptions(notification),
            data: { id: notification.id },
        });
    } catch (error) {
        debugLog("notify", "service-worker notification failed", error);
    }
}
