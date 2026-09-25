/**
 * App shell: sidebar navigation + the signed-in user's footer.
 *
 * The `<nav>` links drive the hash router; the Users entry is owner-only.
 * `children` is the active management view.
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
                <div className="brand">J.A.R.V.I.S.</div>
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
