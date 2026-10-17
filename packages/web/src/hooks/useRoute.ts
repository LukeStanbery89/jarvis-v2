/**
 * The route the browser is on, as React state (#90 phase 6b).
 *
 * `useSyncExternalStore` over the store in `../router`: the address is the
 * source of truth, so there is no route state to keep in step with it — a
 * back/forward step, an in-app link, and a fresh load all read the same value.
 * The third argument is the snapshot React reads when there is no browser (it
 * is inert here; the app is only ever rendered in one).
 */
import { useSyncExternalStore } from "react";
import { currentRoute, subscribeRoute, type AppRoute } from "../router";

/**
 * Follows the browser's address for the component's lifetime.
 *
 * @returns The route `window.location` names right now.
 */
export function useRoute(): AppRoute {
    return useSyncExternalStore(subscribeRoute, currentRoute, () => "home");
}
