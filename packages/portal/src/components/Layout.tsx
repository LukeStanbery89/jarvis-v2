/**
 * App shell: sidebar navigation + the signed-in user's footer.
 *
 * The `<nav>` links drive the hash router; the Users entry is owner-only.
 * `children` is the active management view.
 *
 * The wordmark is the one thing here that is not a route: it is an anchor to
 * `/` (#146), because the app is a different SPA — the portal has no view for
 * it to swap to.
 */
import type { ReactNode } from "react";
import type { ApiUser } from "../types";
import type { Route } from "../routes";

const NAV: { route: Route; label: string; ownerOnly?: boolean }[] = [
    { route: "users", label: "Users", ownerOnly: true },
    { route: "devices", label: "Devices" },
    { route: "sessions", label: "Sessions" },
    { route: "prefs", label: "Prefs" },
];

export function Layout({
    user,
    route,
    onLogout,
    children,
}: {
    user: ApiUser;
    route: Route;
    onLogout: () => void;
    children: ReactNode;
}) {
    return (
        <div className="layout">
            <aside className="sidebar">
                {/* The way back (#146): the admin portal is its own SPA at
                    `/admin`, so this is a real anchor rather than a hash
                    route — and the wordmark is where everyone reaches for
                    "home". Same tab: leaving the panel for the app you were
                    using is a step, not a second window. */}
                <a className="brand" href="/" title="Back to JARVIS">
                    J.A.R.V.I.S.
                </a>
                <nav>
                    {NAV.filter(
                        (item) => !item.ownerOnly || user.role === "owner",
                    ).map((item) => (
                        <a
                            key={item.route}
                            href={`#/${item.route}`}
                            className={route === item.route ? "active" : ""}
                        >
                            {item.label}
                        </a>
                    ))}
                </nav>
                <div className="sidebar-footer">
                    <span className="user-line">
                        <strong>{user.username}</strong>
                        <em>{user.role}</em>
                    </span>
                    <button className="btn ghost" onClick={onLogout}>
                        Sign out
                    </button>
                </div>
            </aside>
            <main className="content">{children}</main>
        </div>
    );
}
