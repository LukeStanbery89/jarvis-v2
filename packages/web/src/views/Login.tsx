/**
 * Sign-in view for the web chat client.
 *
 * Exchanges username + password for a device token at
 * `POST /api/auth/login` (the CLI's flow); the server's error messages
 * (bad credentials, disabled account, rate limiting) surface verbatim.
 * On success the credential is handed up for persistent storage and the
 * app switches to the chat view.
 */
import { useState } from "react";
import { api, type LoginResult } from "../api";

/** Props for {@link Login}. */
export interface LoginProps {
    /** Called with the login result once credentials verify. */
    onSignedIn: (result: LoginResult) => void;
}

/** The forced sign-in gate: no chat without credentials. */
export function Login({ onSignedIn }: LoginProps) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit(event: React.FormEvent): Promise<void> {
        event.preventDefault();
        if (submitting) {
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            onSignedIn(await api.login(username, password));
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "sign-in failed; try again",
            );
            setSubmitting(false);
        }
    }

    return (
        <main className="login">
            <h1>J.A.R.V.I.S. Web</h1>
            <form onSubmit={submit}>
                <label>
                    Username
                    <input
                        name="username"
                        value={username}
                        autoComplete="username"
                        required
                        onChange={(e) => setUsername(e.target.value)}
                    />
                </label>
                <label>
                    Password
                    <input
                        type="password"
                        name="password"
                        value={password}
                        autoComplete="current-password"
                        required
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </label>
                {error && <p className="error">{error}</p>}
                <button type="submit" disabled={submitting}>
                    {submitting ? "Signing in…" : "Sign in"}
                </button>
            </form>
        </main>
    );
}
