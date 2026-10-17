/**
 * The web app shell: the sign-in gate, and the page the current path names.
 *
 * Forced sign-in: without a usable stored credential the login screen is the
 * entry gate; with one, the page re-authenticates the stored device token in
 * the background and any permanent rejection (invalid, revoked, or a REST 401)
 * clears the credential and drops back to the gate. Sign-out clears the
 * credential but deliberately keeps the per-user transcripts.
 *
 * Routing is a live lookup and nothing more (#90 phase 6b): the route comes
 * from `useRoute()`, which follows `window.location` through the store in
 * `./router`, so an in-app link swaps the view without a document load and the
 * browser's Back and Forward work normally. The shell that owns the socket —
 * and therefore keeps a stream alive across a swap — lands with the dashboard.
 */
import { useCallback, useState } from "react";
import type { LoginResult } from "./api";
import {
    clearCredential,
    saveCredential,
    loadCredential,
    type StoredCredential,
} from "./credentials";
import { useRoute } from "./hooks/useRoute";
import { Login } from "./views/Login";
import { Home } from "./views/Home";
import { PagePlaceholder } from "./views/PagePlaceholder";
import { Chat } from "./views/Chat";

/**
 * Routes between the sign-in gate and the path the browser is on based on the
 * stored credential.
 */
export function App() {
    const [credential, setCredential] = useState<StoredCredential | null>(() =>
        loadCredential(localStorage),
    );
    // Called before the sign-in gate returns: hooks run unconditionally, and
    // the route is needed on both sides of it anyway. The store follows the
    // address (`hooks/useRoute`), so a link in the app swaps the view without a
    // document load and Back/Forward arrive through the same subscription.
    const route = useRoute();

    /** Persists a fresh login and enters the app. */
    const onSignedIn = useCallback((result: LoginResult): void => {
        const stored: StoredCredential = {
            username: result.user.username,
            userId: result.user.id,
            token: result.device.token,
            device: {
                id: result.device.id,
                name: result.device.name,
                prefix: result.device.prefix,
            },
        };
        saveCredential(localStorage, stored);
        setCredential(stored);
    }, []);

    /** Clears the credential and returns to the gate (revoked/401/logout). */
    const dropToLogin = useCallback((): void => {
        clearCredential(localStorage);
        setCredential(null);
    }, []);

    if (credential === null) {
        return <Login onSignedIn={onSignedIn} />;
    }

    if (route === "home") {
        return <Home username={credential.username} />;
    }
    if (route === "chat") {
        return (
            <Chat
                credential={credential}
                onAuthRejected={dropToLogin}
                onSignedOut={dropToLogin}
            />
        );
    }
    return (
        <PagePlaceholder
            title={PENDING_PAGES[route].title}
            note={PENDING_PAGES[route].note}
        />
    );
}

/**
 * The pages that exist as addresses before they exist as content (#90 phase
 * 6a). Kept beside the switch, because the copy is the page's placeholder and
 * not the router's business.
 */
const PENDING_PAGES: Record<
    "timers" | "reminders" | "notifications",
    { title: string; note: string }
> = {
    timers: {
        title: "Timers",
        note: "Every countdown you have running, and how long is left.",
    },
    reminders: {
        title: "Reminders",
        note: "What the assistant will remind you about, and when.",
    },
    notifications: {
        title: "Notifications",
        note: "What JARVIS has reported, newest first.",
    },
};
