/**
 * JARVIS's service worker (#189).
 *
 * This is the installable app's offline half, not a data cache. It precaches
 * the built shell and the hashed entry bundle so the app opens without a
 * network, serves every later navigation network-first so a deploy is picked
 * up on the next load, and caches only same-origin static assets after that.
 *
 * Three surfaces deliberately bypass it:
 *
 * - `/api` and `/ws`: weather, jobs, notifications, credentials and the chat
 *   socket are live data. A cached answer here would be a lie, and an expired
 *   one would be worse.
 * - `/admin`: the admin portal is a different SPA on the same origin, with its
 *   own shell and assets. It has no business in this app's cache.
 * - `/health`: a machine endpoint that answers JSON, not the app shell.
 *
 * The build stamps `VERSION` (see `vite.config.ts`), so every build starts a
 * fresh cache pair; the previous pair is deleted when the new worker
 * activates. The worker does **not** call `skipWaiting()`: an open tab keeps
 * its old worker and cache until it closes, so a lazy-loaded chunk cannot
 * vanish underneath it. `clients.claim()` is still used, which gives the first
 * installed worker control of the page that installed it.
 */
const VERSION = "__JARVIS_BUILD__";
const CACHE = `jarvis-v${VERSION}`;

/** The app shell, the install metadata, and the icons a home screen may ask for. */
const CORE = [
    "/",
    "/manifest.webmanifest",
    "/icons/icon.svg",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/icon-maskable-512.png",
    "/icons/apple-touch-icon.png",
];

/** Same-origin paths whose contents are static and safe to serve from cache. */
const STATIC_PATH = /^\/(?:assets|icons|ort)\//;

/** Same-origin paths that must always reach the network (or the socket). */
const LIVE_PATH =
    /^\/(?:api(?:\/|$)|admin(?:\/|$)|health(?:\/|$)|ws(?:\/|$)|sw\.js$)/;

/** Whether a response is the SPA shell rather than JSON or an error page. */
function isHtml(response) {
    return (response.headers.get("content-type") ?? "").includes("text/html");
}

/**
 * Fetches a navigation, refreshing the cached shell when the network has one.
 *
 * A 5xx from a proxy is still an outage from the user's side, so the cached
 * shell is a better answer than the error page. A 4xx is not: a genuinely
 * missing path should stay missing rather than silently becoming the app.
 */
async function navigation(request) {
    try {
        const response = await fetch(request);
        if (response.ok && isHtml(response)) {
            try {
                const cache = await caches.open(CACHE);
                await cache.put("/", response.clone());
            } catch {
                // A full or unavailable cache must not turn a good network
                // response into a failed navigation.
            }
        } else if (response.status >= 500) {
            const cached = await caches.match("/");
            if (cached) {
                return cached;
            }
        }
        return response;
    } catch (error) {
        const cached = await caches.match("/");
        if (cached) {
            return cached;
        }
        throw error;
    }
}

/** Serves a static asset from cache, fetching and caching it on the first use. */
async function asset(request) {
    const cached = await caches.match(request);
    if (cached) {
        return cached;
    }
    const response = await fetch(request);
    if (response.ok) {
        try {
            const cache = await caches.open(CACHE);
            await cache.put(request, response.clone());
        } catch {
            // See `navigation`: serving the network response matters more than
            // whether this browser accepted a copy into its cache.
        }
    }
    return response;
}

self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE);
            // A completed install must be a complete offline shell. Failing
            // here keeps the previous worker and cache alive; a partial new
            // cache followed by activation would silently break offline mode.
            await cache.addAll(CORE);

            // `index.html` names the hashed entry JS/CSS. Cache those now, so
            // the first offline open after installing does not depend on the
            // install page having fetched them through this worker.
            const shell = await cache.match("/");
            if (!shell) {
                return;
            }
            const html = await shell.text();
            const assets = new Set();
            for (const match of html.matchAll(
                /(?:src|href)="(\/assets\/[^"]+)"/g,
            )) {
                assets.add(match[1]);
            }
            await Promise.all([...assets].map((url) => cache.add(url)));
        })(),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(
                keys
                    .filter((key) => key.startsWith("jarvis-") && key !== CACHE)
                    .map((key) => caches.delete(key)),
            );
            await self.clients.claim();
        })(),
    );
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") {
        return;
    }
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
        return;
    }
    if (LIVE_PATH.test(url.pathname)) {
        return;
    }
    if (request.mode === "navigate") {
        event.respondWith(navigation(request));
        return;
    }
    if (
        STATIC_PATH.test(url.pathname) ||
        url.pathname === "/manifest.webmanifest"
    ) {
        event.respondWith(asset(request));
    }
});
