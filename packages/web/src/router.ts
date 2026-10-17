/**
 * The app's addresses (#90 phase 6a).
 *
 * Real paths, not hash routes: the server's SPA fallback already replays
 * `index.html` for any non-`/api` GET, so a deep link and a reload both work
 * without a route on the server, and a URL reads as the page it names. (The
 * admin portal is a different app at `/admin` and keeps its own hash router.)
 *
 * This is deliberately the mapping and nothing more. The interim landing page
 * links with plain anchors, so a click is a real navigation and the app reads
 * `location.pathname` once at boot. The shell that swaps views without a reload
 * — and owns the socket so a route change does not drop a stream — arrives with
 * the dashboard, and it uses this same table rather than a second list of paths.
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
