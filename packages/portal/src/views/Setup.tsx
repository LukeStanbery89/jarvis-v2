/**
 * One-time setup view: creates the first (owner) account.
 *
 * Reachable explicitly from the login screen as `#/setup`. The operator enters
 * the `JARVIS_BOOTSTRAP_TOKEN` they set when launching the server; the token is
 * sent once in `x-bootstrap-token` and the server consumes it, so a leaked env
 * value can never bootstrap a duplicate owner. The bootstrap response carries a
 * device token, not a session — after a successful setup the operator returns
 * to the login screen and signs in normally.
 */
import { useState } from "react";
import { api } from "../api";
import {
    ErrorBanner,
    Field,
    Form,
    InfoBanner,
    SubmitButton,
    errorMessage,
} from "../components/ui";
import { navigate } from "../routes";

export function SetupView() {
    const [token, setToken] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        if (password !== confirm) {
            setError("passwords do not match");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await api.bootstrap(token, username, password);
            setDone(true);
            setBusy(false);
        } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
        }
    };

    return (
        <div className="auth-card">
            <h1>Set up this server</h1>
            <p className="muted">
                Create the first owner account. This step runs once and the
                bootstrap token is consumed when it succeeds.
            </p>
            {done ? (
                <>
                    <InfoBanner>
                        Owner account created. Sign in with the new credentials.
                    </InfoBanner>
                    <button className="btn" onClick={() => navigate("login")}>
                        Back to sign in
                    </button>
                </>
            ) : (
                <>
                    <ErrorBanner>{error}</ErrorBanner>
                    <Form onSubmit={() => void submit()}>
                        <Field
                            label="Bootstrap token (JARVIS_BOOTSTRAP_TOKEN)"
                            type="password"
                            value={token}
                            onChange={setToken}
                            required
                        />
                        <Field
                            label="Owner username"
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
                            autoComplete="new-password"
                            required
                            minLength={8}
                        />
                        <Field
                            label="Confirm password"
                            type="password"
                            value={confirm}
                            onChange={setConfirm}
                            autoComplete="new-password"
                            required
                            minLength={8}
                        />
                        <SubmitButton disabled={busy}>
                            {busy ? "Creating…" : "Create owner account"}
                        </SubmitButton>
                    </Form>
                </>
            )}
            <p className="muted">
                <a href="#/login" onClick={() => navigate("login")}>
                    Back to sign in
                </a>
            </p>
        </div>
    );
}
