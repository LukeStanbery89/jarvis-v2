/**
 * App shell: sidebar navigation + the signed-in user's footer.
 *
 * The `<nav>` links drive the hash router; the Users entry is owner-only.
 * `children` is the active management view.
 *
 * Above 48rem the navigation is a fixed sidebar. Below it the same markup
 * becomes a sticky top bar with a hamburger drawer, so the content column gets
 * the full width of a phone instead of the 220px the sidebar used to take.
 * The account line and Sign out move into that drawer; nothing is duplicated.
 *
 * The wordmark is the one thing here that is not a route: it is an anchor to
 * `/` (#146), because the app is a different SPA — the portal has no view for
 * it to swap to.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { ApiUser } from "../types";
import type { Route } from "../routes";

const NAV: { route: Route; label: string; ownerOnly?: boolean }[] = [
    { route: "users", label: "Users", ownerOnly: true },
    { route: "devices", label: "Devices" },
    { route: "sessions", label: "Sessions" },
    { route: "prefs", label: "Prefs" },
];

/** The complement of the stylesheet's `max-width: 48rem` phone query. */
const DESKTOP_QUERY = "(min-width: 48.001rem)";

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
    const [menuOpen, setMenuOpen] = useState(false);

    // A navigation leaves the drawer behind on the route it was opened from.
    useEffect(() => {
        setMenuOpen(false);
    }, [route]);

    // A resize past the breakpoint turns the drawer back into a permanent
    // sidebar; close it so the scroll lock and scrim do not outlive it.
    useEffect(() => {
        const desktop = window.matchMedia(DESKTOP_QUERY);
        const onChange = () => {
            if (desktop.matches) {
                setMenuOpen(false);
            }
        };
        desktop.addEventListener("change", onChange);
        return () => desktop.removeEventListener("change", onChange);
    }, []);

    // Escape closes the drawer, and while it is open the page behind it must
    // not scroll under the scrim.
    useEffect(() => {
        if (!menuOpen) {
            return;
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setMenuOpen(false);
            }
        };
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            document.body.style.overflow = previousOverflow;
        };
    }, [menuOpen]);

    return (
        <div className="layout">
            {menuOpen ? (
                <button
                    type="button"
                    className="nav-scrim"
                    aria-label="Close navigation"
                    onClick={() => setMenuOpen(false)}
                />
            ) : null}
            <aside className="sidebar">
                <div className="sidebar-top">
                    {/* The way back (#146): the admin portal is its own SPA at
                        `/admin`, so this is a real anchor rather than a hash
                        route — and the wordmark is where everyone reaches for
                        "home". Same tab: leaving the panel for the app you were
                        using is a step, not a second window. */}
                    <a className="brand" href="/" title="Back to JARVIS">
                        J.A.R.V.I.S.
                    </a>
                    <button
                        type="button"
                        className="nav-toggle"
                        aria-expanded={menuOpen}
                        aria-controls="portal-nav"
                        aria-label={
                            menuOpen ? "Close navigation" : "Open navigation"
                        }
                        title={
                            menuOpen ? "Close navigation" : "Open navigation"
                        }
                        onClick={() => setMenuOpen((open) => !open)}
                    >
                        <span className="nav-toggle-icon" aria-hidden="true">
                            <span />
                            <span />
                            <span />
                        </span>
                    </button>
                </div>
                <div
                    id="portal-nav"
                    className={`sidebar-menu${menuOpen ? " open" : ""}`}
                >
                    <nav aria-label="Admin sections">
                        {NAV.filter(
                            (item) => !item.ownerOnly || user.role === "owner",
                        ).map((item) => (
                            <a
                                key={item.route}
                                href={`#/${item.route}`}
                                className={route === item.route ? "active" : ""}
                                aria-current={
                                    route === item.route ? "page" : undefined
                                }
                                onClick={() => setMenuOpen(false)}
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
                </div>
            </aside>
            <main className="content">{children}</main>
        </div>
    );
}
