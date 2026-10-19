/**
 * Router tests (#90 phases 6a–6b).
 *
 * The interesting cases are the ones a URL bar produces — a trailing slash, a
 * case that does not match, a path that is not a page at all — plus the two
 * pieces of the store that no type can check: which clicks a link may claim,
 * and what a navigation does to the address and to its subscribers.
 *
 * The store is tested against a fake `window`: the web package runs Vitest in
 * the node environment (no DOM), and the module reads `window` at call time, so
 * a literal is enough — and it keeps the assertions about *history* and
 * *popstate* explicit rather than implied by a real browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ROUTE_PATHS,
    currentRoute,
    interceptsNavigation,
    navigate,
    routeForPath,
    subscribeRoute,
} from "./router";

describe("routeForPath", () => {
    it("names each path in the table", () => {
        expect(routeForPath("/")).toBe("home");
        expect(routeForPath("/chat")).toBe("chat");
        expect(routeForPath("/timers")).toBe("timers");
        expect(routeForPath("/reminders")).toBe("reminders");
        expect(routeForPath("/notifications")).toBe("notifications");
    });

    it("ignores a trailing slash", () => {
        expect(routeForPath("/chat/")).toBe("chat");
        expect(routeForPath("//")).toBe("home");
    });

    it("sends anything unrecognized to the home page", () => {
        // A typo or an old link is better answered by the front door than by an
        // error the user cannot act on.
        expect(routeForPath("/chatty")).toBe("home");
        expect(routeForPath("/Chat")).toBe("home");
        expect(routeForPath("/chat/42")).toBe("home");
        expect(routeForPath("")).toBe("home");
    });

    it("keeps every path distinct and rooted", () => {
        const paths = Object.values(ROUTE_PATHS);
        expect(new Set(paths).size).toBe(paths.length);
        for (const path of paths) {
            expect(path.startsWith("/")).toBe(true);
        }
    });
});

describe("interceptsNavigation", () => {
    /** A plain left click, from which each case varies one field. */
    const plain = {
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
    };

    it("claims a plain left click", () => {
        expect(interceptsNavigation(plain)).toBe(true);
    });

    it("leaves a modified click to the browser", () => {
        // Cmd-click must open a real tab: the server can serve every path, and
        // the user asked for a new tab, not a swapped view.
        expect(interceptsNavigation({ ...plain, metaKey: true })).toBe(false);
        expect(interceptsNavigation({ ...plain, ctrlKey: true })).toBe(false);
        expect(interceptsNavigation({ ...plain, shiftKey: true })).toBe(false);
        expect(interceptsNavigation({ ...plain, altKey: true })).toBe(false);
    });

    it("leaves a non-primary button alone", () => {
        expect(interceptsNavigation({ ...plain, button: 1 })).toBe(false);
        expect(interceptsNavigation({ ...plain, button: 2 })).toBe(false);
    });

    it("respects a click another handler consumed", () => {
        expect(interceptsNavigation({ ...plain, defaultPrevented: true })).toBe(
            false,
        );
    });
});

/** What the router needs from a browser, plus the test helpers beside it. */
interface FakeWindow {
    location: { pathname: string; search: string };
    history: {
        pushState(state: unknown, title: string, url: string): void;
    };
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
    /** Every URL `pushState` was handed, in order. */
    pushed: string[];
    /** Stands in for the browser's own Back/Forward: moves, then notifies. */
    goTo(pathname: string): void;
}

/**
 * A `window` just real enough for the store.
 *
 * `pushState` parses the same way a browser does for the two fields the app
 * reads (`pathname` and `search`), because "the query survives a click" is one
 * of the behaviours under test.
 */
function createFakeWindow(pathname = "/", search = ""): FakeWindow {
    const listeners = new Map<string, Set<() => void>>();
    const fake: FakeWindow = {
        location: { pathname, search },
        history: {
            pushState(_state, _title, url) {
                const [path, query = ""] = String(url).split("?");
                fake.location.pathname = path;
                fake.location.search = query === "" ? "" : `?${query}`;
                fake.pushed.push(String(url));
            },
        },
        addEventListener(type, listener) {
            const set = listeners.get(type) ?? new Set<() => void>();
            set.add(listener);
            listeners.set(type, set);
        },
        removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener);
        },
        pushed: [],
        goTo(path) {
            fake.location.pathname = path;
            for (const listener of listeners.get("popstate") ?? []) {
                listener();
            }
        },
    };
    return fake;
}

describe("the route store", () => {
    let fake: FakeWindow;

    beforeEach(() => {
        fake = createFakeWindow();
        vi.stubGlobal("window", fake);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("reads the route from the address", () => {
        expect(currentRoute()).toBe("home");
        fake.goTo("/timers");
        expect(currentRoute()).toBe("timers");
    });

    it("pushes one history entry and tells subscribers", () => {
        const announced = vi.fn();
        const unsubscribe = subscribeRoute(announced);

        navigate("chat");

        expect(fake.pushed).toEqual(["/chat"]);
        expect(fake.location.pathname).toBe("/chat");
        expect(announced).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    it("carries the query string across a navigation", () => {
        // The documented dev flags (`?debug=1`, `?voice-trace=1`) are read at
        // boot; losing them on the first click would be a papercut for exactly
        // the person debugging.
        fake = createFakeWindow("/chat", "?debug=1");
        vi.stubGlobal("window", fake);
        const unsubscribe = subscribeRoute(() => {});

        navigate("timers");

        expect(fake.pushed).toEqual(["/timers?debug=1"]);
        unsubscribe();
    });

    it("does not push when the page is already showing", () => {
        // Otherwise every re-click of the current nav item would add a history
        // entry the Back button has to step through.
        fake = createFakeWindow("/chat");
        vi.stubGlobal("window", fake);
        const announced = vi.fn();
        const unsubscribe = subscribeRoute(announced);

        navigate("chat");

        expect(fake.pushed).toEqual([]);
        expect(announced).not.toHaveBeenCalled();
        unsubscribe();
    });

    it("notifies a subscriber for the browser's own navigation", () => {
        const announced = vi.fn();
        const unsubscribe = subscribeRoute(announced);

        fake.goTo("/notifications");

        expect(announced).toHaveBeenCalledTimes(1);
        expect(currentRoute()).toBe("notifications");
        unsubscribe();
    });

    it("stops notifying once unsubscribed", () => {
        const announced = vi.fn();
        const unsubscribe = subscribeRoute(announced);
        unsubscribe();

        navigate("reminders");
        fake.goTo("/chat");

        expect(announced).not.toHaveBeenCalled();
    });
});
