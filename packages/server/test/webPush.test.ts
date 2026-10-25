/**
 * The Web Push channel (#189 follow-up).
 *
 * The transport is injected: a real send would need a browser's push endpoint
 * and network access, while the interesting rules are local — only subscribed
 * browsers are addressed, a timer raises urgency, and a 410 removes the dead
 * row. The service policy that decides *when* this channel runs is covered by
 * the notification-service suite.
 */
import { describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import type {
    AppNotification,
    AppPushSubscription,
} from "@lukestanbery/jarvis-auth";
import { createWebPushChannel } from "../src/notify/channels/webPush";
import type { WebPushSend } from "../src/notify/channels/webPush";

const VAPID = (() => {
    const pair = webpush.generateVAPIDKeys();
    return {
        publicKey: pair.publicKey,
        privateKey: pair.privateKey,
        subject: "mailto:test@example.com",
    };
})();

function subscription(endpoint: string): AppPushSubscription {
    return {
        endpoint,
        p256dh: `p256dh-${endpoint}`,
        auth: `auth-${endpoint}`,
        createdAt: "2026-10-25T18:00:00.000Z",
    };
}

function notification(
    overrides: Partial<AppNotification> = {},
): AppNotification {
    return {
        id: "notification-1",
        userId: 7,
        kind: "job.finished",
        class: "timer",
        priority: "normal",
        title: "Tea is ready",
        body: "The kettle finished.",
        state: "pending",
        requiresAnswer: false,
        dedupeKey: null,
        answer: null,
        jobId: null,
        codingJobId: null,
        createdAt: "2026-10-25T18:00:00.000Z",
        deliveredAt: null,
        settledAt: null,
        ...overrides,
    } as AppNotification;
}

describe("createWebPushChannel", () => {
    it("sends a timer at high urgency to every subscribed browser", async () => {
        const send = vi.fn<WebPushSend>().mockResolvedValue({});
        const store = {
            listPushSubscriptions: vi
                .fn()
                .mockReturnValue([
                    subscription("https://push.example/a"),
                    subscription("https://push.example/b"),
                ]),
            deletePushSubscription: vi.fn(),
        };
        const channel = createWebPushChannel({
            store,
            vapid: VAPID,
            send,
        });

        await expect(channel.deliver(notification())).resolves.toBe(2);
        expect(send).toHaveBeenCalledTimes(2);
        const [target, payload, options] = send.mock.calls[0];
        expect(target).toEqual({
            endpoint: "https://push.example/a",
            keys: {
                p256dh: "p256dh-https://push.example/a",
                auth: "auth-https://push.example/a",
            },
        });
        expect(JSON.parse(payload)).toMatchObject({
            id: "notification-1",
            title: "Tea is ready",
            class: "timer",
            url: "/",
        });
        expect(options).toEqual({ TTL: 300, urgency: "high" });
    });

    it("removes an expired endpoint and keeps sending the rest", async () => {
        const send = vi
            .fn<WebPushSend>()
            .mockRejectedValueOnce(
                Object.assign(new Error("gone"), { statusCode: 410 }),
            )
            .mockResolvedValueOnce({});
        const store = {
            listPushSubscriptions: vi
                .fn()
                .mockReturnValue([
                    subscription("https://push.example/dead"),
                    subscription("https://push.example/live"),
                ]),
            deletePushSubscription: vi.fn(),
        };
        const channel = createWebPushChannel({
            store,
            vapid: VAPID,
            send,
        });

        await expect(
            channel.deliver(notification({ class: "reminder" })),
        ).resolves.toBe(1);
        expect(store.deletePushSubscription).toHaveBeenCalledWith(
            7,
            "https://push.example/dead",
        );
        expect(send).toHaveBeenCalledTimes(2);
    });

    it("returns zero when the account has no subscriptions", async () => {
        const send = vi.fn<WebPushSend>();
        const channel = createWebPushChannel({
            store: {
                listPushSubscriptions: () => [],
                deletePushSubscription: vi.fn(),
            },
            vapid: VAPID,
            send,
        });
        await expect(channel.deliver(notification())).resolves.toBe(0);
        expect(send).not.toHaveBeenCalled();
    });
});
