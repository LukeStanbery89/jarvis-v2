/**
 * Portal shell: bootstraps the session, routes views, and wires the global
 * dead-session redirect used by the API layer.
 *
 * Boot sequence: `GET /api/session` decides signed-in vs not (and recovers the
 * in-memory CSRF nonce after a reload). Signed-out users see Login (or Setup
 * when they've navigated there); signed-in users get the sidebar layout and the
 * active management view. The Users view and owner-scoped lists require the
 * owner role.
 */
import { useEffect, useState } from "react";
import { api, setCsrfToken, setUnauthorizedHandler } from "./api";
import type { ApiUser } from "./types";
import { currentRoute, navigate, onRouteChange } from "./routes";
import { Layout } from "./components/Layout";
import { LoginView } from "./views/Login";
import { SetupView } from "./views/Setup";
import { UsersView } from "./views/Users";
import { DevicesView } from "./views/Devices";
import { SessionsView } from "./views/Sessions";
import { PrefsView } from "./views/Prefs";

export function App() {
    const [booted, setBooted] = useState(false);
    const [user, setUser] = useState<ApiUser | null>(null);
    const [route, setRoute] = useState(currentRoute());

    useEffect(() => {
        // A dead session anywhere in the app bounces back to the login view.
        setUnauthorizedHandler(() => {
            setCsrfToken(null);
            setUser(null);
            navigate("login");
        });
        const unsubscribe = onRouteChange(setRoute);
        void api
            .getSession()
            .then((session) => {
                setCsrfToken(session.csrfToken ?? null);
                setUser(session.user);
            })
            .catch(() => {
                setCsrfToken(null);
                setUser(null);
            })
            .finally(() => setBooted(true));
        return () => {
            setUnauthorizedHandler(null);
            unsubscribe();
        };
    }, []);

    const handleLogin = (loggedIn: ApiUser) => {
        setUser(loggedIn);
        navigate("users");
    };

    const handleLogout = async () => {
        try {
            await api.logout();
        } catch {
            // Logout is best-effort; clear the client anyway.
        }
        setCsrfToken(null);
        setUser(null);
        navigate("login");
    };

    if (!booted) {
        return (
            <div className="boot">
                <div className="brand">J.A.R.V.I.S.</div>
                <p className="muted">Loading…</p>
            </div>
        );
    }

    if (user === null) {
        return route === "setup" ? (
            <div className="center">
                <SetupView />
            </div>
        ) : (
            <div className="center">
                <LoginView onLogin={handleLogin} />
            </div>
        );
    }

    const view =
        route === "users" ? (
            user.role === "owner" ? (
                <UsersView me={user} />
            ) : (
                <p className="panel muted">
                    Only the owner can manage accounts.
                </p>
            )
        ) : route === "devices" ? (
            <DevicesView me={user} />
        ) : route === "sessions" ? (
            <SessionsView me={user} />
        ) : route === "prefs" ? (
            <PrefsView me={user} />
        ) : route === "setup" ? (
            <p className="panel muted">
                You're already signed in — the owner account exists.
            </p>
        ) : (
            <UsersView me={user} />
        );

    return (
        <Layout user={user} route={route} onLogout={() => void handleLogout()}>
            {view}
        </Layout>
    );
}
