/**
 * External-browser escape hatches for source links (#199).
 *
 * Node-only: the pure URL builders and the click decision are tested without
 * a DOM. The platform branches are deliberately small because they encode
 * browser quirks — the tests pin the exact strings those platforms expect.
 */
import { describe, expect, it, vi } from "vitest";
import {
    androidBrowserIntent,
    detectSourceLinkEnvironment,
    openSourceInSystemBrowser,
    safariBrowserUrl,
    type SourceLinkEnvironment,
    type SourceLinkWindow,
} from "./externalBrowser";

function fakeEvent(): { preventDefault: ReturnType<typeof vi.fn<() => void>> } {
    return { preventDefault: vi.fn<() => void>() };
}

function environment(
    overrides: Partial<SourceLinkEnvironment> = {},
): SourceLinkEnvironment {
    return {
        standalone: true,
        platform: "android",
        open: vi.fn(),
        ...overrides,
    };
}

describe("androidBrowserIntent", () => {
    it("builds an external-browser intent with a fallback", () => {
        expect(androidBrowserIntent("https://example.com/a?b=1")).toBe(
            "intent://example.com/a?b=1#Intent;scheme=https;" +
                "action=android.intent.action.VIEW;" +
                "category=android.intent.category.BROWSABLE;" +
                "S.browser_fallback_url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1;end",
        );
    });

    it("rejects non-http URLs", () => {
        expect(androidBrowserIntent("mailto:someone@example.com")).toBeNull();
        expect(androidBrowserIntent("not a url")).toBeNull();
    });
});

describe("safariBrowserUrl", () => {
    it("wraps both web schemes in Safari's external protocol", () => {
        expect(safariBrowserUrl("https://example.com/a")).toBe(
            "x-safari-https://example.com/a",
        );
        expect(safariBrowserUrl("http://example.com/a")).toBe(
            "x-safari-http://example.com/a",
        );
    });

    it("leaves anything else alone", () => {
        expect(safariBrowserUrl("mailto:someone@example.com")).toBeNull();
    });
});

describe("openSourceInSystemBrowser", () => {
    it("lets a normal browser tab use target=_blank", () => {
        const event = fakeEvent();
        const env = environment({ standalone: false, open: vi.fn() });

        expect(
            openSourceInSystemBrowser(event, "https://example.com/a", env),
        ).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(env.open).not.toHaveBeenCalled();
    });

    it("uses an Android intent in a standalone app", () => {
        const event = fakeEvent();
        const env = environment({ platform: "android", open: vi.fn() });

        expect(
            openSourceInSystemBrowser(event, "https://example.com/a", env),
        ).toBe(true);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(env.open).toHaveBeenCalledWith(
            expect.stringContaining("intent://example.com/a#Intent;"),
        );
    });

    it("uses Safari's scheme on iOS in a standalone app", () => {
        const event = fakeEvent();
        const env = environment({ platform: "ios", open: vi.fn() });

        expect(
            openSourceInSystemBrowser(event, "https://example.com/a", env),
        ).toBe(true);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(env.open).toHaveBeenCalledWith("x-safari-https://example.com/a");
    });

    it("opens a new window on a desktop standalone app", () => {
        const event = fakeEvent();
        const env = environment({ platform: "other", open: vi.fn() });

        expect(
            openSourceInSystemBrowser(event, "https://example.com/a", env),
        ).toBe(true);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(env.open).toHaveBeenCalledWith("https://example.com/a");
    });
});

describe("detectSourceLinkEnvironment", () => {
    function windowLike(
        overrides: Partial<SourceLinkWindow> & {
            userAgent?: string;
            platform?: string;
            maxTouchPoints?: number;
            standalone?: boolean;
        } = {},
    ): SourceLinkWindow {
        return {
            matchMedia: () => ({ matches: false }),
            navigator: {
                userAgent:
                    overrides.userAgent ??
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                platform: overrides.platform,
                maxTouchPoints: overrides.maxTouchPoints ?? 0,
                standalone: overrides.standalone,
            },
            location: { assign: vi.fn() },
            open: vi.fn(),
        };
    }

    it("detects a standalone display and an Android user agent", () => {
        const env = detectSourceLinkEnvironment({
            ...windowLike({ userAgent: "Mozilla/5.0 (Linux; Android 15)" }),
            matchMedia: () => ({ matches: true }),
        });

        expect(env.standalone).toBe(true);
        expect(env.platform).toBe("android");
    });

    it("detects iOS from navigator.standalone", () => {
        const env = detectSourceLinkEnvironment(
            windowLike({
                userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)",
                standalone: true,
            }),
        );

        expect(env.standalone).toBe(true);
        expect(env.platform).toBe("ios");
    });

    it("treats an iPad's desktop user agent as iOS", () => {
        const env = detectSourceLinkEnvironment(
            windowLike({
                userAgent:
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
                platform: "MacIntel",
                maxTouchPoints: 5,
            }),
        );

        expect(env.platform).toBe("ios");
    });

    it("leaves a browser tab in the normal anchor path", () => {
        const env = detectSourceLinkEnvironment(windowLike());

        expect(env.standalone).toBe(false);
        expect(env.platform).toBe("other");
    });
});
