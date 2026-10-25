/**
 * Browser Web Push registration (#189 follow-up).
 *
 * The service worker already knows how to receive a push and show a
 * notification; this module is the page's half: request a subscription from the
 * browser's push service, hand its endpoint/keys to JARVIS, and remove it again
 * on sign-out, so a closed or backgrounded PWA can still be told that a timer
 * fired.
 *
 * Feature detection is deliberately context-based, not user-agent-based. iOS
 * only exposes `Notification`/`PushManager` inside a Home Screen web app; a
 * normal tab returns `false` here and keeps using the page's in-app path.
 */
import { api } from "./api";
import type { PushSubscriptionInput } from "./api";
import { debugLog } from "./debug";

/** Whether this page can subscribe to Web Push at all. */
export function pushSupported(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof navigator !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window
    );
}

/**
 * Decodes a base64url VAPID key into the bytes `PushManager.subscribe` wants.
 *
 * @param value - The public key from `GET /api/push/key`.
 * @returns The key bytes.
 */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

/** The JSON shape the browser returns for a subscription. */
interface BrowserSubscriptionJson {
    endpoint: string;
    keys?: { p256dh?: string; auth?: string };
}

/** Reads the browser subscription as the server's input type. */
function toServerSubscription(
    subscription: PushSubscription,
): PushSubscriptionInput {
    const json = subscription.toJSON() as BrowserSubscriptionJson;
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (
        typeof json.endpoint !== "string" ||
        typeof p256dh !== "string" ||
        typeof auth !== "string"
    ) {
        throw new Error("the browser returned an incomplete push subscription");
    }
    return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/**
 * Ensures this browser has a push subscription registered for the account.
 *
 * Call from a user gesture: on iOS, `pushManager.subscribe` must run in the
 * gesture's turn. A missing service worker (dev, or a browser that never
 * registered) is a quiet `false`; the page notification path still works.
 *
 * @param token - The signed-in device token.
 * @returns Whether a subscription is now registered with the server.
 */
export async function ensurePushSubscription(token: string): Promise<boolean> {
    if (!pushSupported() || Notification.permission !== "granted") {
        return false;
    }
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration === undefined) {
        return false;
    }
    try {
        const key = await api.getPushKey(token);
        const existing = await registration.pushManager.getSubscription();
        const subscription =
            existing ??
            (await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: base64UrlToBytes(key.publicKey),
            }));
        await api.subscribePush(token, toServerSubscription(subscription));
        debugLog("push", "browser subscription registered");
        return true;
    } catch (error) {
        debugLog("push", "could not register browser subscription", error);
        return false;
    }
}

/**
 * Removes this browser's push subscription and tells the server to forget it.
 *
 * A server failure is not allowed to leave the browser subscribed: the local
 * unsubscribe runs regardless, and the push service's 404/410 will prune the
 * stale server row on the next delivery attempt.
 *
 * @param token - The signed-in device token.
 */
export async function removePushSubscription(token: string): Promise<void> {
    if (!pushSupported()) {
        return;
    }
    const registration = await navigator.serviceWorker
        .getRegistration()
        .catch(() => undefined);
    const subscription = await registration?.pushManager
        .getSubscription()
        .catch(() => null);
    if (!subscription) {
        return;
    }
    try {
        await api.unsubscribePush(token, subscription.endpoint);
    } catch (error) {
        debugLog("push", "could not remove server subscription", error);
    }
    await subscription.unsubscribe().catch(() => undefined);
    debugLog("push", "browser subscription removed");
}
