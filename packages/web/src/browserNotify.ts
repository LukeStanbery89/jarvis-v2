/**
 * Browser/OS notifications (#139 phase 2) — the pure half.
 *
 * Phase 1 put notifications in the page. This phase lets them reach the
 * operating system while the tab is open, which is a different promise: an OS
 * notification is an *interruption*, so the rules for raising one are
 * deliberately conservative and live here (testable in the node environment,
 * no DOM) rather than inline in an effect.
 *
 * The rule that matters most: **never announce what the user is already
 * looking at.** Raising an OS banner for a notification whose in-app banner is
 * on screen is noise, and it trains people to disable the channel. So a
 * notification is announced only while the document is hidden, at a moment
 * when the browser has actually granted permission and the user has asked for
 * it — and never twice, since the live frame and the fetched page can both
 * mention the same id.
 *
 * The second rule arrived with #90: **only announce what the server actually
 * pushed.** A `pending` row means "recorded, not announced" — quiet hours, the
 * master switch, the delivery budget, or no client being connected — and the OS
 * channel must not overrule that decision from the browser. It also means a
 * timer that fired while this browser was closed does not pop up here: it is
 * `pending` too, and the in-app ring is what greets the user on the next open.
 *
 * The preference is per browser, not per account: the underlying permission is
 * granted by a browser to an origin and cannot be synced, so pretending
 * otherwise (a server pref that says "on" while this browser would refuse)
 * would be a lie in the UI. Web Push, which *does* need server-side state, is
 * phase 3 and brings its own per-device record.
 */
import type { NotificationClass } from "@lukestanbery/jarvis-protocol";
import { describeBody } from "./notifications";

/** What the bell toggle should say and look like. */
export type BrowserNotifyUiState =
    /** No `Notification` global at all (node, or a very old browser). */
    | "unsupported"
    /** The user denied permission: only browser settings can undo that. */
    | "blocked"
    /** Supported and permitted, but switched off. */
    | "off"
    /** Announcing OS notifications for hidden tabs. */
    | "on";

/** The localStorage leaf holding this browser's preference. */
const PREF_LEAF = "browserNotify";

/** Namespaced per-user leaf key (mirrors `credentials.ts`). */
function prefKey(username: string): string {
    return `jarvis.web.user.${username}.${PREF_LEAF}`;
}

/**
 * Reads the stored preference for `username`.
 *
 * Absent or unreadable means "off": the browser will still ask for permission,
 * so an unset preference must not silently opt a user in.
 */
export function loadBrowserNotifyPref(
    storage: Storage,
    username: string,
): boolean {
    try {
        return storage.getItem(prefKey(username)) === "on";
    } catch {
        // Private-mode Safari throws on read; treat it as "no preference".
        return false;
    }
}

/**
 * Persists the preference for `username`.
 *
 * A storage failure is not worth surfacing: the toggle still works for this
 * session, and the notification list — the durable half — is unaffected.
 */
export function saveBrowserNotifyPref(
    storage: Storage,
    username: string,
    on: boolean,
): void {
    try {
        if (on) {
            storage.setItem(prefKey(username), "on");
        } else {
            storage.removeItem(prefKey(username));
        }
    } catch {
        // Ignored on purpose; see above.
    }
}

/**
 * Whether to raise an OS notification for `notification`.
 *
 * Every condition is a reason not to interrupt:
 *
 * - the user asked for it (`enabled`) and the browser agreed (`permission`);
 * - the document is **hidden** — if the tab is visible, the in-app banner is
 *   already the notification;
 * - it has not been announced before (`alreadyAnnounced`), which is what stops
 *   the fetched page and the live frame from double-announcing one id;
 * - it still wants attention (`state`): a notification read on another device
 *   must not pop up here.
 */
export function shouldAnnounce(
    notification: { id: string; state: string },
    context: {
        enabled: boolean;
        /** The account's master switch (`notify.enabled`), not the browser one. */
        masterEnabled: boolean;
        permission: string;
        hidden: boolean;
        /** Ids already announced in this session. */
        announced: ReadonlySet<string>;
    },
): boolean {
    if (
        !context.enabled ||
        !context.masterEnabled ||
        context.permission !== "granted"
    ) {
        return false;
    }
    if (!context.hidden) {
        return false;
    }
    if (context.announced.has(notification.id)) {
        return false;
    }
    // `delivered` is the server saying "this reached a live client"; anything
    // else was recorded without being pushed, and the browser has no standing
    // to promote it. Read/answered/snoozed cannot be delivered, so this one
    // comparison covers the old settled check too.
    return notification.state === "delivered";
}

/**
 * The line under an OS notification's title.
 *
 * Body when there is one that says something the title does not
 * ({@link describeBody} — a restated headline is dropped, and an announcement with
 * no second line reads as a truncated title), otherwise a hint at what the
 * notification wants.
 */
export function notificationBody(notification: {
    title?: string;
    body?: string;
    requiresAnswer?: boolean;
    class?: NotificationClass;
}): string {
    const body = describeBody(notification);
    if (body !== null) {
        return body;
    }
    if (notification.class === "timer") {
        // A timer with nothing to add is not "a notification": it is time.
        return "Your timer has finished.";
    }
    return notification.requiresAnswer === true
        ? "J.A.R.V.I.S. needs your answer."
        : "J.A.R.V.I.S. sent you a notification.";
}

/**
 * The `Notification` constructor options for one row.
 *
 * Two things are class-specific:
 *
 * - a timer's popup is **sticky** (`requireInteraction`), the visual half of
 *   "rings until acknowledged" — the sound stays ours (Web Audio), so the OS
 *   only has to keep the card on screen;
 * - `tag` is the notification id, so a re-raise of the same row replaces its
 *   popup instead of stacking a second one.
 */
export function notificationOptions(notification: {
    id: string;
    class: NotificationClass;
    /**
     * The headline, so the body can be checked against it ({@link describeBody}):
     * a popup whose two lines are one sentence twice reads worse than one line.
     */
    title?: string;
    body?: string;
    requiresAnswer?: boolean;
}): { body: string; tag: string; requireInteraction: boolean } {
    return {
        body: notificationBody(notification),
        tag: notification.id,
        requireInteraction: notification.class === "timer",
    };
}

/** The toggle's label and tooltip for a UI state. */
export function describeBrowserNotifyState(
    state: BrowserNotifyUiState,
): string {
    switch (state) {
        case "unsupported":
            return "Desktop notifications unavailable in this browser";
        case "blocked":
            return "Desktop notifications blocked — allow them in your browser settings";
        case "off":
            return "Desktop notifications for background tabs (off)";
        case "on":
            return "Desktop notifications for background tabs (on)";
    }
}

/**
 * Derives the toggle's state from the environment.
 *
 * `denied` is a distinct state rather than "off" because it is not fixable
 * from here: the browser will not re-prompt, so the UI has to tell the user
 * where to go instead of asking again.
 */
export function browserNotifyState(
    supported: boolean,
    permission: string,
    enabled: boolean,
): BrowserNotifyUiState {
    if (!supported) {
        return "unsupported";
    }
    if (permission === "denied") {
        return "blocked";
    }
    return enabled && permission === "granted" ? "on" : "off";
}
