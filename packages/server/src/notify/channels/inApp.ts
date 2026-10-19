/**
 * The in-app channel (#139 phase 1): push the notification to the user's open
 * chat clients over `/ws`.
 *
 * This is the first {@link NotificationChannel} and the only one phase 1
 * ships. It is capability-poor on purpose — text only, no speech, no images —
 * which is exactly what a chat socket can do; a client that declared `audio`
 * still receives a *text* notification, and turning that into speech is a
 * later channel's decision, not this one's.
 *
 * The frame is built from the stored record rather than from the producer's
 * request, so what the user sees on the wire is what was persisted — a
 * notification the client can match against its `GET /api/notifications` list
 * by id, and therefore never render twice.
 */
import type {
    NotificationFrame,
    ServerFrame,
} from "@lukestanbery/jarvis-protocol";
import type { AppNotification } from "@lukestanbery/jarvis-auth";
import type {
    NotificationChannel,
    NotificationChannelCapabilities,
} from "../types";
import type { NotificationHub } from "../hub";

/**
 * What an in-app push can do: show text, collect a reply over the normal chat
 * path, on a user's *account* rather than one addressable device. It cannot
 * speak or show images — TTS is a presentation concern of the client and a
 * notification never carries binary payloads.
 */
export const IN_APP_CAPABILITIES: NotificationChannelCapabilities = {
    canSpeak: false,
    canShowText: true,
    canShowImage: false,
    canAcceptReply: true,
    isAddressable: false,
};

/** Maps a stored notification onto its wire frame. */
export function toNotificationFrame(
    notification: AppNotification,
): NotificationFrame {
    return {
        notification: {
            id: notification.id,
            kind: notification.kind,
            class: notification.class,
            priority: notification.priority,
            title: notification.title,
            ...(notification.body !== null && notification.body.length > 0
                ? { body: notification.body }
                : {}),
            createdAt: notification.createdAt,
            ...(notification.requiresAnswer ? { requiresAnswer: true } : {}),
            // The job behind the announcement (#90 phase 5), when there is one:
            // a client that wants to act on the reminder rather than merely
            // acknowledge it needs the id, and the list route already returns it
            // — a frame without it would be the one place that knows less.
            ...(notification.jobId !== null
                ? { jobId: notification.jobId }
                : {}),
        },
    };
}

/**
 * Builds the in-app channel over a connection registry.
 *
 * @returns A channel whose `deliver` returns the number of sockets the frame
 * reached — so the service can distinguish "the user was present" from "the
 * push went nowhere" without consulting the hub itself.
 */
export function createInAppChannel(hub: NotificationHub): NotificationChannel {
    return {
        id: "in-app",
        capabilities: IN_APP_CAPABILITIES,
        deliver(notification: AppNotification): number {
            const frame: ServerFrame = toNotificationFrame(notification);
            return hub.deliver(notification.userId, frame);
        },
    };
}
