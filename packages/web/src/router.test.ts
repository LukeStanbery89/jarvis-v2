/**
 * Router tests (#90 phase 6a).
 *
 * The interesting cases are the ones a URL bar produces: a trailing slash, a
 * case that does not match, and a path that is not a page at all. A wrong
 * answer here shows the wrong view, which no type can catch.
 */
import { describe, expect, it } from "vitest";
import { ROUTE_PATHS, routeForPath } from "./router";

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
