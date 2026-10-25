/**
 * Service-worker registration for the installable app (#189).
 *
 * The worker itself is `public/sw.js`; this module decides whether the current
 * page may register it. Production only: Vite's dev server compiles modules on
 * demand and serves them through HMR, and a worker that cached those responses
 * would hand the browser stale modules at URLs that never change. A secure
 * context is also required by the platform — the same HTTPS-or-localhost rule
 * that location and the microphone already follow — so the check is explicit
 * rather than relying on `serviceWorker` being absent.
 *
 * Registration waits for `load` so installing the worker never competes with
 * the first paint. A failure is only a debug line: the app is fully usable
 * without a service worker, and the user should not see a PWA error for a
 * deployment choice they cannot fix from here.
 */
import { debugLog } from "./debug";

/** The worker's public URL, at the root so its default scope is the whole app. */
export const SERVICE_WORKER_URL = "/sw.js";

/** The inputs that decide whether this page may register the worker. */
export interface ServiceWorkerEnvironment {
    /** Whether this is a production build (`import.meta.env.PROD`). */
    production: boolean;
    /** Whether the browser exposes the Service Worker API. */
    supported: boolean;
    /** Whether the page is in a secure context (HTTPS or localhost). */
    secure: boolean;
}

/**
 * Whether the worker should be registered.
 *
 * Split out from the DOM work so the rule is testable in the node environment:
 * dev builds and insecure origins never register.
 *
 * @param env - The current build and browser capabilities.
 * @returns True only for a supported, secure production page.
 */
export function shouldRegisterServiceWorker(
    env: ServiceWorkerEnvironment,
): boolean {
    return env.production && env.supported && env.secure;
}

/**
 * Registers the app's service worker after the first paint.
 *
 * No-ops in development, on unsupported browsers, and outside a secure
 * context. Safe to call unconditionally from the entry point.
 */
export function registerServiceWorker(): void {
    const container =
        typeof navigator !== "undefined" && "serviceWorker" in navigator
            ? navigator.serviceWorker
            : undefined;
    const env: ServiceWorkerEnvironment = {
        production: import.meta.env.PROD,
        supported: container !== undefined,
        secure:
            typeof window !== "undefined" && window.isSecureContext === true,
    };
    if (!shouldRegisterServiceWorker(env) || container === undefined) {
        if (env.production) {
            debugLog(
                "pwa",
                `service worker not registered (supported=${env.supported} secure=${env.secure})`,
            );
        }
        return;
    }

    const start = (): void => {
        void container
            .register(SERVICE_WORKER_URL, {
                scope: "/",
                // A reverse proxy or CDN that decides to cache `sw.js` must not
                // pin the app to a retired worker; the server sends max-age=0,
                // and this is the client-side half of that promise.
                updateViaCache: "none",
            })
            .then((registration) => {
                debugLog(
                    "pwa",
                    `service worker registered scope=${registration.scope}`,
                );
            })
            .catch((error: unknown) => {
                debugLog("pwa", "service worker registration failed", error);
            });
    };

    if (document.readyState === "complete") {
        start();
    } else {
        window.addEventListener("load", start, { once: true });
    }
}
