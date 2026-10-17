/**
 * The app's addresses, and the client-side store that follows them (#90 phases
 * 6a–6b).
 *
 * Real paths, not hash routes: the server's SPA fallback already replays
 * `index.html` for any non-`/api` GET, so a deep link and a reload both work
 * without a route on the server, and a URL reads as the page it names. (The
 * admin portal is a different app at `/admin` and keeps its own hash router.)
 *
 * The store is deliberately tiny — a listener set over `window.location`, read
 * through `useRoute` with `useSyncExternalStore` — because the address is
 * already the state: a `popstate`, an in-app link, or a fresh load all read the
 * same value, and nothing has to be kept in step with it.
 *
 * An {@link AppLink} click is claimed, pushed and announced, so the app swaps
 * views **without a document load**. What that buys is not speed but
 * continuity: the socket the shell owns stays connected, and a turn that is
 * mid-stream keeps landing in the transcript while the user looks at another
 * page. Back and forward are the browser's own navigation and arrive as
 * `popstate`, which is why {@link navigate} announces explicitly rather than
 * dispatching a synthetic one (and so needs no `PopStateEvent` constructor).
 */

/** One addressable page in the app. */
export type AppRoute =
    "home" | "chat" | "timers" | "reminders" | "notifications";

/** The one place the paths are written down (a link and a route cannot drift). */
export const ROUTE_PATHS: Record<AppRoute, string> = {
    home: "/",
    chat: "/chat",
    timers: "/timers",
    reminders: "/reminders",
    notifications: "/notifications",
};

/**
 * The route a pathname names.
 *
 * Unrecognized paths are the home page rather than a 404 view: the only way to
 * arrive at one is a typo or an old link, and the app's front door is a better
 * answer than an error — the same posture the server's fallback takes when it
 * replays the shell.
 *
 * @param pathname - `location.pathname` (a trailing slash is ignored, so
 *   `/chat/` is the chat).
 * @returns The matching route, or `home`.
 */
export function routeForPath(pathname: string): AppRoute {
    const normalized = pathname.replace(/\/+$/, "") || "/";
    const entry = (Object.entries(ROUTE_PATHS) as [AppRoute, string][]).find(
        ([, path]) => path === normalized,
    );
    return entry === undefined ? "home" : entry[0];
}

/** The route the browser is on now. */
export function currentRoute(): AppRoute {
    return routeForPath(window.location.pathname);
}

/** Everything waiting to hear that the address changed. */
const listeners = new Set<() => void>();

/**
 * Subscribes to address changes (the `useSyncExternalStore` contract).
 *
 * Each subscriber gets its own `popstate` registration, so a back/forward step
 * notifies everyone without a module-level listener that would outlive the app
 * (and without a side effect at import time). `navigate` announces through
 * {@link listeners} instead, because `pushState` fires no event of its own.
 *
 * @param listener - Called whenever the address changes, from any cause.
 * @returns An unsubscribe function.
 */
export function subscribeRoute(listener: () => void): () => void {
    listeners.add(listener);
    window.addEventListener("popstate", listener);
    return () => {
        listeners.delete(listener);
        window.removeEventListener("popstate", listener);
    };
}

/** Tells every subscriber to re-read the address. */
function announce(): void {
    for (const listener of listeners) {
        listener();
    }
}

/**
 * Navigates to a route without a document load.
 *
 * The current query string is carried over on purpose: the documented dev flags
 * (`?debug=1`, `?voice-trace=1`) are read at boot, and someone poking at the app
 * with one on should not lose it the moment they click a link. Navigating to
 * the page already showing is not a navigation, so it leaves no history entry
 * for the Back button to step through.
 *
 * @param route - The page to show.
 */
export function navigate(route: AppRoute): void {
    const path = ROUTE_PATHS[route];
    if (window.location.pathname === path) {
        return;
    }
    window.history.pushState(null, "", `${path}${window.location.search}`);
    announce();
}

/**
 * The parts of a click that decide whether a link may claim it.
 *
 * Structural rather than React's event type so the rule is a plain predicate
 * the unit tests can hand a literal (the web package runs without a DOM).
 */
export interface ClickIntent {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    defaultPrevented: boolean;
}

/**
 * Whether a click should be handled in-app.
 *
 * Anything the user could mean by "somewhere else" — a modified click, a
 * non-primary button, or a click a handler already consumed — is left to the
 * browser, so Cmd-click opens a real tab whose URL the server can serve (it
 * can: every path replays the shell).
 *
 * @param event - The click being considered.
 * @returns True when the link should call `preventDefault` and navigate.
 */
export function interceptsNavigation(event: ClickIntent): boolean {
    return (
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.defaultPrevented
    );
}
