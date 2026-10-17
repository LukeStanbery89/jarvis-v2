/**
 * The web app shell: the sign-in gate, and the page the current path names.
 *
 * Forced sign-in: without a usable stored credential the login screen is the
 * entry gate; with one, the page re-authenticates the stored device token in
 * the background and any permanent rejection (invalid, revoked, or a REST 401)
 * clears the credential and drops back to the gate. Sign-out clears the
 * credential but deliberately keeps the per-user transcripts.
 *
 * Routing is a path lookup and nothing more (#90 phase 6a): `/` is the interim
 * launcher, `/chat` is the conversation, and the pages that are not built yet
 * say so. Every link is a plain anchor, so a click is a real navigation and this
 * one read of `location.pathname` is the whole router — the shell that swaps
 * views without a reload (and keeps the socket alive across the swap) lands with
 * the dashboard.
 */
import { useCallback, useState } from "react";
import type { LoginResult } from "./api";
import {
    clearCredential,
    saveCredential,
    loadCredential,
    type StoredCredential,
} from "./credentials";
import { routeForPath } from "./router";
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

    // Read once per load: a link is a navigation, so arriving here *is* the
    // route change.
    const route = routeForPath(window.location.pathname);
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
