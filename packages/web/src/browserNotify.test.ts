/**
 * Browser/OS notification rules (#139 phase 2).
 *
 * The interesting cases are all *refusals*: the point of this phase is that
 * JARVIS gains a second way to interrupt, and every condition here is a
 * reason not to. A regression that announces a visible tab, re-announces an
 * id, or pops up something already read is exactly the kind of thing that gets
 * a notification channel switched off permanently.
 */
import { describe, expect, it } from "vitest";
import {
    browserNotifyState,
    describeBrowserNotifyState,
    loadBrowserNotifyPref,
    notificationBody,
    saveBrowserNotifyPref,
    shouldAnnounce,
} from "./browserNotify";

/** A minimal in-memory `Storage`, since the node env has none. */
function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
        get length() {
            return map.size;
        },
        clear: () => map.clear(),
        getItem: (key: string) => map.get(key) ?? null,
        key: (index: number) => [...map.keys()][index] ?? null,
        removeItem: (key: string) => void map.delete(key),
        setItem: (key: string, value: string) => void map.set(key, value),
    };
}

const baseContext = {
    enabled: true,
    permission: "granted",
    hidden: true,
    announced: new Set<string>(),
};

describe("shouldAnnounce", () => {
    it("announces an unsettled notification while the tab is hidden", () => {
        expect(
            shouldAnnounce(
                { id: "n1", state: "delivered" },
                { ...baseContext, announced: new Set<string>() },
            ),
        ).toBe(true);
    });

    it("never announces what the user is already looking at", () => {
        expect(
            shouldAnnounce(
                { id: "n1", state: "delivered" },
                { ...baseContext, hidden: false },
            ),
        ).toBe(false);
    });

    it("requires both the user's preference and the browser's permission", () => {
        expect(
            shouldAnnounce(
                { id: "n1", state: "delivered" },
                { ...baseContext, enabled: false },
            ),
        ).toBe(false);
        for (const permission of ["default", "denied"]) {
            expect(
                shouldAnnounce(
                    { id: "n1", state: "delivered" },
                    { ...baseContext, permission },
                ),
            ).toBe(false);
        }
    });

    it("announces an id at most once per session", () => {
        const announced = new Set<string>();
        expect(
            shouldAnnounce(
                { id: "n1", state: "delivered" },
                {
                    ...baseContext,
                    announced,
                },
            ),
        ).toBe(true);
        announced.add("n1");
        // The fetched page mentioning the same id must not pop up again.
        expect(
            shouldAnnounce(
                { id: "n1", state: "delivered" },
                {
                    ...baseContext,
                    announced,
                },
            ),
        ).toBe(false);
        // ...while a *different* id is still announced.
        expect(
            shouldAnnounce(
                { id: "n2", state: "delivered" },
                {
                    ...baseContext,
                    announced,
                },
            ),
        ).toBe(true);
    });

    it("stays quiet for anything already settled", () => {
        for (const state of ["read", "answered", "dismissed"]) {
            expect(
                shouldAnnounce(
                    { id: "n1", state },
                    {
                        ...baseContext,
                        announced: new Set<string>(),
                    },
                ),
            ).toBe(false);
        }
        // `pending` was never pushed, so it is worth announcing if it is the
        // first thing this session sees.
        expect(
            shouldAnnounce(
                { id: "n1", state: "pending" },
                {
                    ...baseContext,
                    announced: new Set<string>(),
                },
            ),
        ).toBe(true);
    });
});

describe("notificationBody", () => {
    it("prefers the body and falls back to what the notification wants", () => {
        expect(notificationBody({ body: "4 files changed." })).toBe(
            "4 files changed.",
        );
        expect(notificationBody({ requiresAnswer: true })).toBe(
            "J.A.R.V.I.S. needs your answer.",
        );
        expect(notificationBody({})).toBe(
            "J.A.R.V.I.S. sent you a notification.",
        );
        // An empty body is a producer bug, not a reason to render a blank line.
        expect(notificationBody({ body: "" })).toBe(
            "J.A.R.V.I.S. sent you a notification.",
        );
    });
});

describe("preference storage", () => {
    it("round-trips per user without leaking across accounts", () => {
        const storage = memoryStorage();
        expect(loadBrowserNotifyPref(storage, "luke")).toBe(false);
        expect(loadBrowserNotifyPref(storage, "pepper")).toBe(false);

        saveBrowserNotifyPref(storage, "luke", true);
        expect(loadBrowserNotifyPref(storage, "luke")).toBe(true);
        expect(loadBrowserNotifyPref(storage, "pepper")).toBe(false);

        saveBrowserNotifyPref(storage, "luke", false);
        expect(loadBrowserNotifyPref(storage, "luke")).toBe(false);
    });

    it("survives a storage that throws (private-mode Safari)", () => {
        const hostile = {
            ...memoryStorage(),
            getItem: () => {
                throw new Error("denied");
            },
            setItem: () => {
                throw new Error("denied");
            },
            removeItem: () => {
                throw new Error("denied");
            },
        } as Storage;
        expect(loadBrowserNotifyPref(hostile, "luke")).toBe(false);
        expect(() =>
            saveBrowserNotifyPref(hostile, "luke", true),
        ).not.toThrow();
    });
});

describe("browserNotifyState", () => {
    it("distinguishes unsupported, blocked, off, and on", () => {
        expect(browserNotifyState(false, "granted", true)).toBe("unsupported");
        // Denied is never reported as "off": the browser will not re-prompt,
        // so the UI must send the user to its settings instead of asking again.
        expect(browserNotifyState(true, "denied", true)).toBe("blocked");
        expect(browserNotifyState(true, "default", true)).toBe("off");
        expect(browserNotifyState(true, "granted", false)).toBe("off");
        expect(browserNotifyState(true, "granted", true)).toBe("on");
    });

    it("describes every state", () => {
        for (const state of ["unsupported", "blocked", "off", "on"] as const) {
            expect(describeBrowserNotifyState(state).length).toBeGreaterThan(0);
        }
    });
});
