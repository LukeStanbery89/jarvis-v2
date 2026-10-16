/**
 * Notification list-merge tests (#139).
 *
 * The rules worth pinning are the ones a React layer gets wrong: a pushed
 * frame and a fetched page carrying the same id must not render twice, and a
 * frame must never un-read or un-dismiss something the user already settled
 * (the wire frame has no state, so a naive spread would reset it to
 * `delivered`).
 */
import { describe, expect, it } from "vitest";
import {
    describeDelivery,
    describeNotificationState,
    isSettled,
    mergeNotification,
    mergeNotificationPage,
    NOTIFICATION_LIMIT,
    selectBanner,
    settleNotification,
    unreadCount,
} from "./notifications";
import type { ClientNotification } from "./notifications";

/** A notification fixture with sensible defaults. */
function make(
    overrides: Partial<ClientNotification> & { id: string },
): ClientNotification {
    return {
        kind: "k",
        priority: "normal",
        title: `title ${overrides.id}`,
        createdAt: "2026-10-15T10:00:00.000Z",
        state: "delivered",
        ...overrides,
    };
}

describe("mergeNotification", () => {
    it("inserts a new notification newest first", () => {
        const list = [make({ id: "old", createdAt: "2026-10-15T09:00:00Z" })];
        const merged = mergeNotification(
            list,
            make({ id: "new", createdAt: "2026-10-15T11:00:00Z" }),
        );
        expect(merged.map((n) => n.id)).toEqual(["new", "old"]);
    });

    it("replaces a known id in place instead of duplicating it", () => {
        const list = [
            make({ id: "a", title: "from the page" }),
            make({ id: "b" }),
        ];
        const merged = mergeNotification(
            list,
            make({ id: "a", title: "from the frame" }),
        );
        expect(merged).toHaveLength(2);
        expect(merged.find((n) => n.id === "a")?.title).toBe("from the frame");
    });

    it("never un-settles a notification the user already read or dismissed", () => {
        const read = mergeNotification(
            [make({ id: "a", state: "read" })],
            // A frame (or refetch) arrives with the wire's implicit
            // "delivered" state and must not undo the local read.
            make({ id: "a", state: "delivered" }),
        );
        expect(read[0].state).toBe("read");

        const dismissed = mergeNotification(
            [make({ id: "b", state: "dismissed" })],
            make({ id: "b", state: "pending" }),
        );
        expect(dismissed[0].state).toBe("dismissed");
    });

    it("keeps a stored answer when a later frame repeats the id", () => {
        const list = [make({ id: "a", state: "answered", answer: "React 19" })];
        const merged = mergeNotification(list, make({ id: "a" }));
        expect(merged[0]).toMatchObject({
            state: "answered",
            answer: "React 19",
        });
    });

    it("bounds the list, dropping the oldest", () => {
        let list: ClientNotification[] = [];
        for (let i = 0; i < NOTIFICATION_LIMIT + 5; i += 1) {
            list = mergeNotification(
                list,
                make({
                    id: `n${i}`,
                    createdAt: new Date(
                        Date.UTC(2026, 9, 15, 10, i),
                    ).toISOString(),
                }),
            );
        }
        expect(list).toHaveLength(NOTIFICATION_LIMIT);
        expect(list[0].id).toBe(`n${NOTIFICATION_LIMIT + 4}`);
        expect(list.some((n) => n.id === "n0")).toBe(false);
    });
});

describe("mergeNotificationPage", () => {
    it("keeps a locally dismissed row that the page no longer includes", () => {
        const local = [
            make({ id: "gone", state: "dismissed" }),
            make({ id: "kept" }),
        ];
        const merged = mergeNotificationPage(local, [
            make({ id: "kept", title: "refetched" }),
        ]);
        expect(merged.map((n) => n.id).sort()).toEqual(["gone", "kept"]);
        expect(merged.find((n) => n.id === "gone")?.state).toBe("dismissed");
    });

    it("adopts the page's content for a row it re-sends", () => {
        const merged = mergeNotificationPage(
            [make({ id: "a", title: "stale", state: "pending" })],
            [make({ id: "a", title: "fresh", state: "delivered" })],
        );
        expect(merged[0]).toMatchObject({
            title: "fresh",
            state: "delivered",
        });
    });
});

describe("settleNotification", () => {
    it("settles a known id and returns the same list for an unknown one", () => {
        const list = [make({ id: "a" })];
        expect(settleNotification(list, "a", "read")[0].state).toBe("read");
        expect(settleNotification(list, "missing", "read")).toBe(list);
    });

    it("records an answer alongside the state", () => {
        const settled = settleNotification(
            [make({ id: "a" })],
            "a",
            "answered",
            { answer: "yes" },
        );
        expect(settled[0]).toMatchObject({ state: "answered", answer: "yes" });
    });
});

describe("describeDelivery", () => {
    it("names every gate that can hold a notification back", () => {
        expect(describeDelivery(1, null)).toBe("pushed to 1 connected client");
        expect(describeDelivery(2, null)).toBe("pushed to 2 connected clients");
        expect(describeDelivery(0, "absent")).toContain(
            "no client was connected",
        );
        expect(describeDelivery(0, "quiet-hours")).toContain("quiet hours");
        expect(describeDelivery(0, "cap")).toContain("delivery budget");
        expect(describeDelivery(0, "disabled")).toContain("switched off");
    });
});

describe("selectBanner and unreadCount", () => {
    it("surfaces the newest unsettled notification", () => {
        const list = [
            make({ id: "read", state: "read" }),
            make({ id: "newest", createdAt: "2026-10-15T12:00:00Z" }),
            make({ id: "older", createdAt: "2026-10-15T11:00:00Z" }),
        ];
        expect(selectBanner(list)?.id).toBe("newest");
    });

    it("has no banner when everything is settled", () => {
        expect(selectBanner([make({ id: "a", state: "read" })])).toBeNull();
        expect(selectBanner([])).toBeNull();
    });

    it("counts everything not read, answered, or dismissed", () => {
        expect(
            unreadCount([
                make({ id: "a", state: "delivered" }),
                make({ id: "b", state: "pending" }),
                make({ id: "c", state: "read" }),
                make({ id: "d", state: "answered" }),
                make({ id: "e", state: "dismissed" }),
            ]),
        ).toBe(2);
    });

    it("explains each state in words a user can act on", () => {
        expect(describeNotificationState("pending")).toContain("not announced");
        expect(describeNotificationState("delivered")).toBe("new");
        expect(describeNotificationState("read")).toBe("read");
        expect(describeNotificationState("answered")).toBe("answered");
        expect(describeNotificationState("dismissed")).toBe("dismissed");
    });

    it("agrees with isSettled on what counts as done", () => {
        expect(isSettled("pending")).toBe(false);
        expect(isSettled("delivered")).toBe(false);
        expect(isSettled("read")).toBe(true);
        expect(isSettled("answered")).toBe(true);
        expect(isSettled("dismissed")).toBe(true);
    });
});
