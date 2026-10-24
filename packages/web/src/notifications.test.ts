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
    describeBody,
    describeDelivery,
    describeDue,
    describeNotice,
    describeNotificationState,
    fromFrame,
    fromRecord,
    isRinging,
    isSettled,
    mergeNotification,
    mergeNotificationPage,
    NOTIFICATION_LIMIT,
    RING_MAX_AGE_MS,
    selectAlerts,
    selectBanner,
    TOAST_LIMIT,
    removeNotification,
    selectToasts,
    settleNotification,
    shouldToast,
    unreadCount,
} from "./notifications";
import type { ClientNotification } from "./notifications";
import type { Notification } from "./api";
import type { NotificationFrame } from "@lukestanbery/jarvis-protocol";

/** A notification fixture with sensible defaults. */
function make(
    overrides: Partial<ClientNotification> & { id: string },
): ClientNotification {
    return {
        kind: "k",
        class: "notification",
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

    it("never un-settles a notification the user already read or deferred", () => {
        const read = mergeNotification(
            [make({ id: "a", state: "read" })],
            // A frame (or refetch) arrives with the wire's implicit
            // "delivered" state and must not undo the local read.
            make({ id: "a", state: "delivered" }),
        );
        expect(read[0].state).toBe("read");

        const deferred = mergeNotification(
            [make({ id: "b", state: "snoozed" })],
            make({ id: "b", state: "pending" }),
        );
        expect(deferred[0].state).toBe("snoozed");
    });

    it("keeps a stored answer when a later frame repeats the id", () => {
        const list = [make({ id: "a", state: "answered", answer: "React 19" })];
        const merged = mergeNotification(list, make({ id: "a" }));
        expect(merged[0]).toMatchObject({
            state: "answered",
            answer: "React 19",
        });
    });

    it("keeps the coding-job link when a later frame repeats the id (#94)", () => {
        const list = [
            make({
                id: "a",
                requiresAnswer: true,
                codingJobId: "c1",
                state: "delivered",
            }),
        ];
        const merged = mergeNotification(list, make({ id: "a" }));
        expect(merged[0]).toMatchObject({
            requiresAnswer: true,
            codingJobId: "c1",
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

describe("removeNotification (#90 phase 9c)", () => {
    it("takes the row out rather than settling it", () => {
        // Dismissal deletes server-side, so there is no state to leave behind:
        // nothing to show, count, or sort into a column.
        const list = [make({ id: "a" }), make({ id: "b" })];
        expect(removeNotification(list, "a").map((n) => n.id)).toEqual(["b"]);
    });

    it("hands back the same list when the row is not there", () => {
        // Same array, so a render that removed an already-gone row (a repeat
        // dismissal racing a frame) does not re-render the page for nothing.
        const list = [make({ id: "a" })];
        expect(removeNotification(list, "gone")).toBe(list);
    });
});

describe("mergeNotificationPage", () => {
    it("keeps a local row the page no longer includes", () => {
        // The page is a window, not the whole list: a row past its limit is
        // absent for arithmetic reasons, not because it was removed.
        const local = [
            make({ id: "gone", state: "read" }),
            make({ id: "kept" }),
        ];
        const merged = mergeNotificationPage(local, [
            make({ id: "kept", title: "refetched" }),
        ]);
        expect(merged.map((n) => n.id).sort()).toEqual(["gone", "kept"]);
        expect(merged.find((n) => n.id === "gone")?.state).toBe("read");
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

    it("counts everything not settled", () => {
        expect(
            unreadCount([
                make({ id: "a", state: "delivered" }),
                make({ id: "b", state: "pending" }),
                make({ id: "c", state: "read" }),
                make({ id: "d", state: "answered" }),
                make({ id: "e", state: "snoozed" }),
            ]),
        ).toBe(2);
    });

    it("explains each state in words a user can act on", () => {
        expect(describeNotificationState("pending")).toContain("not announced");
        expect(describeNotificationState("delivered")).toBe("new");
        expect(describeNotificationState("read")).toBe("read");
        expect(describeNotificationState("answered")).toBe("answered");
        expect(describeNotificationState("snoozed")).toBe("snoozed");
    });

    it("does not blame the user's absence for a held-back notification", () => {
        // The record does not store *why* it was not announced, and quiet hours
        // is one of the reasons — so naming "while you were away" was wrong for
        // exactly the case a user is most likely to hit while watching.
        expect(describeNotificationState("pending")).not.toMatch(/away/);
    });

    it("agrees with isSettled on what counts as done", () => {
        expect(isSettled("pending")).toBe(false);
        expect(isSettled("delivered")).toBe(false);
        expect(isSettled("read")).toBe(true);
        expect(isSettled("answered")).toBe(true);
        expect(isSettled("snoozed")).toBe(true);
    });
});

/** A REST record fixture (the mapper takes the contract type as-is). */
function record(
    overrides: Partial<Notification> & { id: string },
): Notification {
    return {
        kind: "job.finished",
        class: "notification",
        priority: "normal",
        title: `title ${overrides.id}`,
        state: "delivered",
        createdAt: "2026-10-15T10:00:00.000Z",
        ...overrides,
    };
}

describe("the snoozed state (#90 phase 6c)", () => {
    it("is settled: not unread, and a frame cannot un-settle it", () => {
        const list = [make({ id: "r", class: "reminder", state: "snoozed" })];
        expect(isSettled("snoozed")).toBe(true);
        expect(unreadCount(list)).toBe(0);
        // The server's own push can race the snooze: the record's state wins, or
        // the row would start asking for attention again.
        expect(
            mergeNotification(list, make({ id: "r", class: "reminder" }))[0]
                .state,
        ).toBe("snoozed");
    });

    it("does not toast, because the deferral was the acknowledgement", () => {
        const list = [
            make({ id: "r", class: "reminder", state: "snoozed" }),
            make({ id: "read", class: "reminder", state: "read" }),
        ];
        expect(selectToasts(list, { enabled: true })).toEqual([]);
    });

    it("reads as `snoozed` in the list's state column", () => {
        expect(describeNotificationState("snoozed")).toBe("snoozed");
    });
});

describe("describeBody (#90 phase 6c)", () => {
    it("drops a body that is the title again", () => {
        // The plain duplicate: the model filled both fields with one sentence.
        expect(
            describeBody({ title: "Call Mum", body: "call mum." }),
        ).toBeNull();
        expect(describeBody({ title: "Kettle", body: "  KETTLE " })).toBeNull();
    });

    it("drops a body that is the title behind a reminder turn of phrase", () => {
        // The case that prompted this: "Do a test" over "Remind me to do a test".
        expect(
            describeBody({
                title: "Do a test",
                body: "Remind me to do a test",
            }),
        ).toBeNull();
        expect(
            describeBody({
                title: "Take the bins out",
                body: "don't forget to take the bins out!",
            }),
        ).toBeNull();
    });

    it("keeps a body that carries anything the title does not", () => {
        // The rule has to be narrow: this is exactly what the field is for, and a
        // looser test ("the body mentions the title") would eat it.
        expect(
            describeBody({
                title: "AC filter",
                body: "Change the AC filter in the hall",
            }),
        ).toBe("Change the AC filter in the hall");
        expect(
            describeBody({ title: "Printer", body: "3 files changed." }),
        ).toBe("3 files changed.");
    });

    it("has nothing to say about an absent or empty body", () => {
        expect(describeBody({ title: "Kettle" })).toBeNull();
        expect(describeBody({ title: "Kettle", body: "" })).toBeNull();
        expect(describeBody({ title: "Kettle", body: "   " })).toBeNull();
    });

    it("keeps the body when there is no title to compare against", () => {
        // An OS popup built from a partial row: nothing to judge redundancy by, so
        // the body is the best available line.
        expect(describeBody({ body: "4 files changed." })).toBe(
            "4 files changed.",
        );
    });

    it("returns the original text, not the normalised form", () => {
        expect(describeBody({ title: "Kettle", body: "Boils in 2 min." })).toBe(
            "Boils in 2 min.",
        );
    });
});

describe("shouldToast and selectToasts (#90 phases 6b–6c)", () => {
    it("toasts a reminder", () => {
        // A reminder exists for a moment: arriving *is* the event the user asked
        // to be told about, and it never rings.
        expect(shouldToast(make({ id: "r", class: "reminder" }))).toBe(true);
    });

    it("toasts a timer that failed or was missed", () => {
        // The one timer that does not ring, because there is no moment to
        // acknowledge — and it is still news.
        expect(
            shouldToast(make({ id: "f", class: "timer", kind: "job.failed" })),
        ).toBe(true);
        expect(
            shouldToast(make({ id: "m", class: "timer", kind: "job.missed" })),
        ).toBe(true);
    });

    it("leaves an informational notification to the badge", () => {
        expect(shouldToast(make({ id: "i", class: "notification" }))).toBe(
            false,
        );
    });

    it("shows every row worth interrupting for, newest first", () => {
        // Several reminders in the same minute is the normal case: showing one and
        // leaving the rest to the badge is what made them look lost (#90 phase 6c).
        const list = [
            make({ id: "info", class: "notification" }),
            make({ id: "reminder", class: "reminder" }),
            make({ id: "older", class: "reminder" }),
        ];
        expect(
            selectToasts(list, { enabled: true }).map((row) => row.id),
        ).toEqual(["reminder", "older"]);
    });

    it("shows one card per job, even when a series fired twice", () => {
        // #90 phase 9a: a series supersedes its own announcement, and the stack
        // agrees — the newest firing of a minutely reminder is one card that
        // updates, not three identical ones in the corner.
        const list = [
            make({ id: "newest", class: "reminder", jobId: "j1" }),
            make({ id: "older", class: "reminder", jobId: "j1" }),
            make({ id: "other", class: "reminder", jobId: "j2" }),
        ];
        expect(
            selectToasts(list, { enabled: true }).map((row) => row.id),
        ).toEqual(["newest", "other"]);
    });

    it("stops at the limit, however many are owed", () => {
        // Past the limit the list and the badge are the answer; a corner with ten
        // cards is a wall, not a notification.
        const list = Array.from({ length: TOAST_LIMIT + 4 }, (_, index) =>
            make({ id: `r${index}`, class: "reminder" }),
        );
        expect(selectToasts(list, { enabled: true })).toHaveLength(TOAST_LIMIT);
    });

    it("skips rows the user already settled", () => {
        const list = [
            make({ id: "read", class: "reminder", state: "read" }),
            make({ id: "snoozed", class: "reminder", state: "snoozed" }),
        ];
        expect(selectToasts(list, { enabled: true })).toEqual([]);
    });

    it("stays silent while the account's master switch is off", () => {
        // The switch means "do not interrupt me". The record still exists and
        // still counts on the badge; only the shouting stops.
        const list = [make({ id: "r", class: "reminder" })];
        expect(selectToasts(list, { enabled: false })).toEqual([]);
    });

    it("can never show the timer that is ringing", () => {
        // Structural rather than a check inside the selector: only a fired
        // `timer` rings (`isRinging`), and only a failed or missed one toasts —
        // so a fired timer appears in exactly one loud place, the overlay. Pinned
        // here so a change to either rule has to notice this.
        const fired = make({
            id: "kettle",
            class: "timer",
            kind: "job.finished",
            createdAt: "2026-10-17T10:00:00.000Z",
        });
        const { ring } = selectAlerts([fired], {
            enabled: true,
            now: new Date("2026-10-17T10:05:00.000Z"),
        });
        expect(ring?.id).toBe("kettle");
        expect(selectToasts([fired], { enabled: true })).toEqual([]);
    });
});

describe("the class carriers (#90)", () => {
    it("keeps the class and the pushed state from a frame", () => {
        const frame: NotificationFrame["notification"] = {
            id: "n1",
            kind: "job.finished",
            class: "timer",
            priority: "normal",
            title: "kettle",
            body: "Take it off the heat.",
            createdAt: "2026-10-17T07:20:18.000Z",
        };

        expect(fromFrame(frame)).toEqual({
            id: "n1",
            kind: "job.finished",
            class: "timer",
            priority: "normal",
            title: "kettle",
            body: "Take it off the heat.",
            createdAt: "2026-10-17T07:20:18.000Z",
            state: "delivered",
        });
    });

    it("keeps the class, state, and answer from a record", () => {
        expect(
            fromRecord(
                record({
                    id: "n2",
                    kind: "job.finished",
                    class: "reminder",
                    title: "Call Mum",
                    state: "answered",
                    answer: "on it",
                }),
            ),
        ).toMatchObject({
            id: "n2",
            class: "reminder",
            state: "answered",
            answer: "on it",
        });
    });

    it("carries the job link from whichever side delivered it (#90 phase 5)", () => {
        // A frame and a record must agree: the link is what a snooze writes to,
        // and a live reminder is snoozable without waiting for a list refresh.
        const frame: NotificationFrame["notification"] = {
            id: "n3",
            kind: "job.finished",
            class: "reminder",
            priority: "normal",
            title: "Call Mum",
            createdAt: "2026-10-17T07:20:18.000Z",
            jobId: "0f3a91bc",
        };
        expect(fromFrame(frame).jobId).toBe("0f3a91bc");
        expect(fromRecord(record({ id: "n4", jobId: "0f3a91bc" })).jobId).toBe(
            "0f3a91bc",
        );
        // A notification no job stands behind carries no key at all, so an
        // action can tell "nothing to act on" from "act on job x".
        expect(fromRecord(record({ id: "n5" }))).not.toHaveProperty("jobId");
    });
});

describe("selectAlerts and isRinging (#90)", () => {
    /** Thursday 2026-10-01 18:00 local — the "now" most cases judge against. */
    const NOW = new Date(2026, 9, 1, 18, 0, 0);

    /** A fired timer, `minutesAgo` before {@link NOW}. */
    function timer(
        id: string,
        minutesAgo: number,
        overrides: Partial<ClientNotification> = {},
    ): ClientNotification {
        return make({
            id,
            kind: "job.finished",
            class: "timer",
            createdAt: new Date(
                NOW.getTime() - minutesAgo * 60_000,
            ).toISOString(),
            ...overrides,
        });
    }

    const enabled = { enabled: true, now: NOW };

    it("rings a fired timer, and does not repeat it as the banner", () => {
        const list = [timer("kettle", 1)];

        expect(selectAlerts(list, enabled)).toEqual({
            ring: list[0],
            banner: null,
        });
    });

    it("still banners a newer informational row while a timer rings", () => {
        const list = [
            make({
                id: "info",
                createdAt: new Date(NOW.getTime() - 30_000).toISOString(),
            }),
            timer("kettle", 2),
        ];

        const alerts = selectAlerts(list, enabled);

        expect(alerts.ring?.id).toBe("kettle");
        expect(alerts.banner?.id).toBe("info");
    });

    it("queues two timers oldest first, so the longest wait is acknowledged", () => {
        const list = [timer("newer", 1), timer("older", 10)];

        expect(selectAlerts(list, enabled).ring?.id).toBe("older");
    });

    it("rings a timer that was only recorded while no client was connected", () => {
        // The closed-browser case: the row is `pending`, not `delivered`.
        const list = [timer("kettle", 5, { state: "pending" })];

        expect(selectAlerts(list, enabled).ring?.id).toBe("kettle");
    });

    it("does not ring a timer that failed or was missed — it banners", () => {
        for (const kind of ["job.failed", "job.missed"]) {
            const list = [timer("kettle", 5, { kind })];
            const alerts = selectAlerts(list, enabled);
            expect(alerts.ring).toBeNull();
            expect(alerts.banner?.id).toBe("kettle");
        }
    });

    it("does not ring a timer the user already settled", () => {
        const list = [timer("kettle", 5, { state: "read" })];

        expect(selectAlerts(list, enabled)).toEqual({
            ring: null,
            banner: null,
        });
    });

    it("does not ring with the master switch off, but the record still shows", () => {
        const list = [timer("kettle", 5)];

        const alerts = selectAlerts(list, { enabled: false, now: NOW });

        expect(alerts.ring).toBeNull();
        expect(alerts.banner?.id).toBe("kettle");
    });

    it("rings inside the window and stops at its edge", () => {
        const atEdge = timer("edge", 0, {
            createdAt: new Date(NOW.getTime() - RING_MAX_AGE_MS).toISOString(),
        });
        const tooOld = timer("old", 0, {
            createdAt: new Date(
                NOW.getTime() - RING_MAX_AGE_MS - 1,
            ).toISOString(),
        });

        expect(isRinging(atEdge, enabled)).toBe(true);
        expect(isRinging(tooOld, enabled)).toBe(false);
        expect(selectAlerts([tooOld], enabled).banner?.id).toBe("old");
    });

    it("does not ring when the timestamp cannot be read", () => {
        const broken = timer("broken", 1, { createdAt: "not a date" });

        expect(isRinging(broken, enabled)).toBe(false);
    });
});

describe("describeDue (#90)", () => {
    /** Same local clock for every case, so the suite is timezone-proof. */
    const NOW = new Date(2026, 9, 1, 18, 0, 0);

    it("says when it fired, in the local clock", () => {
        expect(
            describeDue(
                {
                    createdAt: new Date(NOW.getTime() - 20_000).toISOString(),
                },
                NOW,
            ),
        ).toBe("due at 5:59 PM");
    });

    it("adds how late it is once a minute has passed", () => {
        expect(
            describeDue(
                {
                    createdAt: new Date(
                        NOW.getTime() - 3 * 60_000,
                    ).toISOString(),
                },
                NOW,
            ),
        ).toBe("due at 5:57 PM, 3 minutes ago");
    });

    it("uses hours and days when that is the natural unit", () => {
        expect(
            describeDue(
                {
                    createdAt: new Date(
                        NOW.getTime() - 2 * 3_600_000,
                    ).toISOString(),
                },
                NOW,
            ),
        ).toBe("due at 4:00 PM, 2 hours ago");
        expect(
            describeDue(
                {
                    createdAt: new Date(
                        NOW.getTime() - 3 * 86_400_000,
                    ).toISOString(),
                },
                NOW,
            ),
        ).toBe("due at 6:00 PM, 3 days ago");
    });

    it("falls back honestly when the record has no readable time", () => {
        expect(describeDue({ createdAt: "nonsense" }, NOW)).toBe("due now");
    });
});

describe("describeNotice (#90)", () => {
    it("names the class, and how a scheduled one ended", () => {
        expect(describeNotice({ class: "timer", kind: "job.finished" })).toBe(
            "Timer",
        );
        expect(
            describeNotice({ class: "reminder", kind: "job.finished" }),
        ).toBe("Reminder");
        expect(
            describeNotice({ class: "notification", kind: "agent.request" }),
        ).toBe("Notification");
        // A failed or missed job has nothing due, so the label carries the
        // outcome rather than leaving the body to explain it.
        expect(describeNotice({ class: "timer", kind: "job.failed" })).toBe(
            "Timer failed",
        );
        expect(describeNotice({ class: "reminder", kind: "job.missed" })).toBe(
            "Reminder missed",
        );
    });
});
