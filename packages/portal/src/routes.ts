/**
 * Tiny hash-based router (no react-router dependency).
 *
 * The portal is a static SPA: client-side routes live in the URL hash
 * (`#/users`, `#/devices`, …) so a reload stays on the same view. The server's
 * SPA fallback serves `index.html` for every non-`/api` GET, which the hash
 * survives trivially.
 */

export type Route =
    "login" | "setup" | "users" | "devices" | "sessions" | "prefs";

const ROUTES: ReadonlySet<string> = new Set([
    "login",
    "setup",
    "users",
    "devices",
    "sessions",
    "prefs",
]);

/** Parses the current `#/route` into a {@link Route}, defaulting to `users`. */
export function currentRoute(): Route {
    const name = window.location.hash.replace(/^#\/?/, "").toLowerCase();
    return (ROUTES.has(name) ? name : "users") as Route;
}

/** Navigates to a route by setting the URL hash. */
export function navigate(route: Route): void {
    window.location.hash = `#/${route}`;
}

/** Calls `listener` whenever the hash changes; returns an unsubscribe fn. */
export function onRouteChange(listener: (route: Route) => void): () => void {
    const handler = () => listener(currentRoute());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
}
