/**
 * Login view: username + password → `POST /api/session`.
 *
 * The server sets the `jarvis_session` cookie and returns the CSRF nonce; the
 * nonce is stored in memory by `api.ts` and echoed back on mutations. A link to
 * the one-time Setup view points first-run operators at bootstrap.
 */
import { useState } from "react";
import { api } from "../api";
import type { ApiUser } from "../types";
import {
    ErrorBanner,
    Field,
    Form,
    SubmitButton,
    errorMessage,
} from "../components/ui";
import { navigate } from "../routes";

export function LoginView({ onLogin }: { onLogin: (user: ApiUser) => void }) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            const session = await api.login(username, password);
            onLogin(session.user);
        } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
        }
    };

    return (
        <div className="auth-card">
            <h1>Sign in</h1>
            <p className="muted">
                Log in with your J.A.R.V.I.S. account to manage this server.
            </p>
            <ErrorBanner>{error}</ErrorBanner>
            <Form onSubmit={() => void submit()}>
                <Field
                    label="Username"
                    value={username}
                    onChange={setUsername}
                    autoComplete="username"
                    required
                />
                <Field
                    label="Password"
                    type="password"
                    value={password}
                    onChange={setPassword}
                    autoComplete="current-password"
                    required
                />
                <SubmitButton disabled={busy}>
                    {busy ? "Signing in…" : "Sign in"}
                </SubmitButton>
            </Form>
            <p className="muted">
                First run?{" "}
                <a href="#/setup" onClick={() => navigate("setup")}>
                    Set up the owner account
                </a>
            </p>
        </div>
    );
}
