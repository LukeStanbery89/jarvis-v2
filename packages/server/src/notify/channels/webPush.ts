/**
 * Web Push channel (#189 follow-up): the way a timer reaches a phone whose
 * installed PWA is backgrounded or closed.
 *
 * iOS suspends a Home Screen app's JavaScript when it leaves the foreground, so
 * neither Web Audio nor the page's `Notification` path can run at the moment a
 * timer fires. Web Push is the platform's answer: the server encrypts a small
 * payload to each subscribed browser, and the service worker receives it and
 * calls `showNotification()` even when the page is not running.
 *
 * The channel is deliberately **onlyWhenAbsent**: while an in-app socket is
 * present, the page already owns the ring and the OS banner (and has the audio
 * context/game loop the push path cannot use). A second push for that page
 * would duplicate the interruption. When the socket is gone — the normal state
 * after the phone backgrounds or locks — this channel is the only one left.
 *
 * Since #194 a targeted timer names a device, and only that device's push
 * subscriptions are selected. Account-wide notifications (and legacy timers)
 * carry no target and still reach every subscribed browser.
 */
import webpush from "web-push";
import type { PushSubscription as WebPushSubscription } from "web-push";
import { plainText } from "@lukestanbery/jarvis-protocol";
import type {
    AppPushSubscription,
    PushSubscriptionLedger,
} from "@lukestanbery/jarvis-auth";
import type { PushConfig } from "../../config";
import { logger } from "../../logger";
import type {
    NotificationChannel,
    NotificationChannelCapabilities,
} from "../types";

/** What a push can do: text on a device, but no reply channel. */
export const WEB_PUSH_CAPABILITIES: NotificationChannelCapabilities = {
    canSpeak: false,
    canShowText: true,
    canShowImage: false,
    canAcceptReply: false,
    isAddressable: true,
    requiresPresence: false,
    onlyWhenAbsent: true,
};

/** The `web-push` sender shape, injectable so the channel is testable. */
export type WebPushSend = (
    subscription: WebPushSubscription,
    payload: string,
    options: { TTL: number; urgency: "high" | "normal" },
) => Promise<unknown>;

/** Dependencies for {@link createWebPushChannel}. */
export interface WebPushChannelOptions {
    /** Reads/removes this account's browser subscriptions. */
    store: Pick<
        PushSubscriptionLedger,
        "listPushSubscriptions" | "deletePushSubscription"
    >;
    /** VAPID identity and contact. */
    vapid: PushConfig;
    /** Override the sender for tests. */
    send?: WebPushSend;
}

/** Maps a stored row to the shape `web-push` expects. */
function toWebPushSubscription(
    subscription: AppPushSubscription,
): WebPushSubscription {
    return {
        endpoint: subscription.endpoint,
        keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
        },
    };
}

/**
 * Builds the Web Push channel.
 *
 * Delivery is best-effort per browser: one dead endpoint is removed (404/410)
 * and any other provider failure is logged, but a notification already stored
 * in the ledger is never failed by a push error. The service's `deliver`
 * contract is "return how many recipients were reached", not "throw".
 *
 * @param options - The subscription ledger, VAPID pair, and optional sender.
 * @returns A channel ready to be added to the notification service.
 */
export function createWebPushChannel(
    options: WebPushChannelOptions,
): NotificationChannel {
    const { store, vapid } = options;
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    const send: WebPushSend =
        options.send ??
        ((subscription, payload, sendOptions) =>
            webpush.sendNotification(subscription, payload, sendOptions));

    return {
        id: "web-push",
        capabilities: WEB_PUSH_CAPABILITIES,
        async deliver(notification): Promise<number> {
            const subscriptions =
                notification.targetDeviceId === null
                    ? store.listPushSubscriptions(notification.userId)
                    : store.listPushSubscriptions(
                          notification.userId,
                          notification.targetDeviceId,
                      );
            if (subscriptions.length === 0) {
                return 0;
            }
            // The service worker has no Markdown renderer, and a push arrives
            // when the page cannot do the conversion (#147). Strip the stored
            // body here so the background popup gets the same readable text as
            // the page's own OS notification; the REST record keeps Markdown
            // for the list and toast.
            const body =
                notification.body === null ? "" : plainText(notification.body);
            const payload = JSON.stringify({
                id: notification.id,
                title: notification.title,
                ...(body.length > 0 ? { body } : {}),
                class: notification.class,
                priority: notification.priority,
                url: "/",
            });
            let delivered = 0;
            for (const subscription of subscriptions) {
                try {
                    await send(toWebPushSubscription(subscription), payload, {
                        TTL: 300,
                        urgency:
                            notification.class === "timer" ? "high" : "normal",
                    });
                    delivered += 1;
                } catch (err) {
                    const status = (err as { statusCode?: number }).statusCode;
                    if (status === 404 || status === 410) {
                        // The browser unsubscribed, the app was removed, or the
                        // endpoint expired. Drop the dead row so the next timer
                        // does not pay for it again.
                        store.deletePushSubscription(
                            notification.userId,
                            subscription.endpoint,
                        );
                        continue;
                    }
                    logger.warn(
                        `web push failed for user ${notification.userId}: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                }
            }
            return delivered;
        },
    };
}
