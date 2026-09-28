/**
 * The web chat client shell.
 *
 * Forced sign-in: without a usable stored credential the login screen is the
 * entry gate; with one, the chat view re-authenticates the stored device
 * token in the background and any permanent rejection (invalid, revoked, or
 * a REST 401) clears the credential and drops back to the gate. Sign-out
 * clears the credential but deliberately keeps the per-user transcripts.
 */
import { useCallback, useState } from "react";
import type { LoginResult } from "./api";
import {
    clearCredential,
    saveCredential,
    loadCredential,
    type StoredCredential,
} from "./credentials";
import { Login } from "./views/Login";
import { Chat } from "./views/Chat";

/**
 * Routes between the sign-in gate and the chat surface based on the stored
 * credential.
 */
export function App() {
    const [credential, setCredential] = useState<StoredCredential | null>(() =>
        loadCredential(localStorage),
    );

    /** Persists a fresh login and enters the chat. */
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
    return (
        <Chat
            credential={credential}
            onAuthRejected={dropToLogin}
            onSignedOut={dropToLogin}
        />
    );
}
