/**
 * Opening an original source from inside an installed app (#199).
 *
 * A normal browser tab is the easy case: the source card is an ordinary
 * `target="_blank"` anchor. An installed PWA is not — `target="_blank"` and
 * `window.open` commonly open an in-app browser with no address bar or tab
 * switcher, which is not what a user following a source expects. On Android
 * that escape is an `intent://` URL; on iOS it is Safari's `x-safari-https`
 * scheme. This module isolates those platform quirks behind one tiny click
 * decision, so the component stays declarative and the URL builders stay
 * unit-testable without a DOM.
 *
 * Desktop (and any platform without a known escape) keeps the plain anchor
 * behavior; a new window is the best available equivalent there.
 */

/** The platform whose standalone-PWA escape hatch we should use. */
export type SourcePlatform = "android" | "ios" | "other";

/** Everything a source click needs to know about its environment. */
export interface SourceLinkEnvironment {
    /** Whether the app is running installed / standalone rather than in a tab. */
    standalone: boolean;
    /** Which escape hatch to use when standalone. */
    platform: SourcePlatform;
    /** Opens a URL in the platform's external browser. */
    open(url: string): void;
}

/**
 * Builds an Android browser intent for `url`.
 *
 * The `intent://` scheme asks Android's activity resolver to handle the URL
 * outside the current web-app container. `BROWSABLE` keeps it to browser-like
 * handlers, and `browser_fallback_url` is the platform's own fallback when no
 * browser claims it. The original fragment is left to the fallback URL: the
 * fragment position is already spoken for by `#Intent`.
 *
 * @param url - An absolute `http(s)` URL.
 * @returns The intent URL, or `null` for anything else.
 */
export function androidBrowserIntent(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
    }
    const scheme = parsed.protocol.slice(0, -1);
    const fallback = encodeURIComponent(parsed.href);
    return (
        `intent://${parsed.host}${parsed.pathname}${parsed.search}` +
        `#Intent;scheme=${scheme};action=android.intent.action.VIEW;` +
        `category=android.intent.category.BROWSABLE;` +
        `S.browser_fallback_url=${fallback};end`
    );
}

/**
 * Wraps an `http(s)` URL in Safari's external scheme on iOS.
 *
 * @param url - An absolute `http(s)` URL.
 * @returns The `x-safari-*` URL, or `null` for anything else.
 */
export function safariBrowserUrl(url: string): string | null {
    if (/^https:\/\//i.test(url)) {
        return `x-safari-https://${url.slice("https://".length)}`;
    }
    if (/^http:\/\//i.test(url)) {
        return `x-safari-http://${url.slice("http://".length)}`;
    }
    return null;
}

/**
 * Decides whether a click needs the platform escape hatch.
 *
 * Returns `false` for a normal browser tab, letting the anchor's
 * `target="_blank"` do the work. In a standalone app it prevents the in-app
 * navigation and hands the URL to the platform's external browser instead.
 *
 * @param event - The click event (only `preventDefault` is used).
 * @param url - The vetted source URL.
 * @param env - The detected display mode and platform.
 * @returns Whether the click was diverted.
 */
export function openSourceInSystemBrowser(
    event: { preventDefault(): void },
    url: string,
    env: SourceLinkEnvironment,
): boolean {
    if (!env.standalone) {
        return false;
    }
    if (env.platform === "android") {
        const intent = androidBrowserIntent(url);
        if (intent === null) {
            return false;
        }
        event.preventDefault();
        env.open(intent);
        return true;
    }
    if (env.platform === "ios") {
        const safari = safariBrowserUrl(url);
        if (safari === null) {
            return false;
        }
        event.preventDefault();
        env.open(safari);
        return true;
    }
    // A desktop PWA has no custom-scheme escape hatch. A new window is the
    // closest equivalent and, unlike the in-app viewer, gets normal browser
    // controls where the platform supports it.
    event.preventDefault();
    env.open(url);
    return true;
}

/** The bits of `Window`/`Navigator` this module reads (injectable for tests). */
export interface SourceLinkWindow {
    matchMedia?(query: string): { matches: boolean };
    navigator: {
        userAgent: string;
        platform?: string;
        maxTouchPoints?: number;
        standalone?: boolean;
    };
    location: { assign(url: string): void };
    open(
        url: string,
        target?: string,
        features?: string,
    ): { focus?(): void } | null;
}

/**
 * Detects whether the page is an installed app and which escape it needs.
 *
 * iOS exposes `navigator.standalone`; other browsers use the display-mode
 * media query. iPadOS's desktop user agent is included because an iPad can be
 * a standalone app while identifying itself as a Mac.
 *
 * @param win - The page window (injectable so tests stay DOM-free).
 * @returns The display mode, platform, and external opener for clicks.
 */
export function detectSourceLinkEnvironment(
    win: SourceLinkWindow,
): SourceLinkEnvironment {
    const displayModes = ["standalone", "fullscreen", "minimal-ui"];
    const mediaStandalone =
        typeof win.matchMedia === "function" &&
        displayModes.some(
            (mode) => win.matchMedia?.(`(display-mode: ${mode})`).matches,
        );
    const standalone = mediaStandalone || win.navigator.standalone === true;
    const ua = win.navigator.userAgent;
    const platform: SourcePlatform = /Android/i.test(ua)
        ? "android"
        : /iPad|iPhone|iPod/i.test(ua) ||
            (win.navigator.platform === "MacIntel" &&
                (win.navigator.maxTouchPoints ?? 0) > 1)
          ? "ios"
          : "other";
    return {
        standalone,
        platform,
        open: (url) => {
            // `location.assign` is what lets iOS's x-safari scheme leave the
            // app; an Android intent is likewise a top-level navigation, not
            // a popup. Desktop uses a real window.
            if (platform === "ios" || platform === "android") {
                win.location.assign(url);
            } else {
                win.open(url, "_blank", "noopener,noreferrer");
            }
        },
    };
}
