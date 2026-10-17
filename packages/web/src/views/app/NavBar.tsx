/**
 * The app's top bar (#90 phase 6b): the wordmark, the pages, the account, the
 * connection state, and the unread badge.
 *
 * The wordmark is the way home — it links to the dashboard — so the pages listed
 * here are the four destinations other than it. Under 48rem the links collapse
 * behind a hamburger; the badge is rendered on both the Notifications link and
 * the hamburger, and one of the two is always hidden by the same media query, so
 * the count follows whichever affordance is showing the link. Two nodes and one
 * breakpoint, rather than a JavaScript width probe that would disagree with the
 * CSS on the first paint.
 *
 * The account name follows the same rule: in the bar's right corner while the
 * links are visible, and at the top of the drawer when they are not. It used to
 * live in the chat sidebar, which made it a fact about the conversation rather
 * than about the app.
 *
 * The connection state lives here rather than in the conversation view: now that
 * the socket outlives a route change it is a fact about the app, and
 * "reconnecting…" should be visible from every page.
 */
import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { AppLink } from "../../AppLink";
import { useRoute } from "../../hooks/useRoute";
import type { ChatStatus } from "../../ChatClient";
import type { AppRoute } from "../../router";

/** The pages the bar lists, in order (home is the wordmark). */
const LINKS: { to: AppRoute; label: string }[] = [
    { to: "chat", label: "Chat" },
    { to: "timers", label: "Timers" },
    { to: "reminders", label: "Reminders" },
    { to: "notifications", label: "Notifications" },
];

/** What the connection chip says while the socket is not `connected`. */
const STATUS_TEXT: Record<Exclude<ChatStatus, "connected">, string> = {
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    closed: "Offline",
};

/** The sentence behind the chip, for its tooltip and for screen readers. */
const STATUS_SENTENCE: Record<Exclude<ChatStatus, "connected">, string> = {
    connecting: "Connecting…",
    reconnecting: "Connection dropped — reconnecting…",
    closed: "Disconnected",
};

/** Props for {@link NavBar}. */
export interface NavBarProps {
    /** The signed-in account name (the bar on wide screens, the menu on narrow). */
    username: string;
    /** Notifications neither read nor dismissed (the badge). */
    unread: number;
    /** The socket's lifecycle, for the connection chip. */
    status: ChatStatus;
}

/**
 * The connection chip.
 *
 * A silent no-op while the socket is up: a permanent "Connected" would be
 * furniture, and the interesting states are the other three.
 */
function ConnectionChip({ status }: { status: ChatStatus }) {
    if (status === "connected") {
        return null;
    }
    return (
        <span
            className="navbar-status"
            role="status"
            title={STATUS_SENTENCE[status]}
            aria-label={STATUS_SENTENCE[status]}
        >
            <span className="navbar-status-dot" aria-hidden="true" />
            {STATUS_TEXT[status]}
        </span>
    );
}

/**
 * The top bar.
 *
 * @param props - See {@link NavBarProps}.
 */
export function NavBar({ username, unread, status }: NavBarProps) {
    const route = useRoute();
    const [menuOpen, setMenuOpen] = useState(false);
    const barRef = useRef<HTMLElement | null>(null);

    // A navigation closes the drawer: its links are the only reason it is open,
    // and leaving it up would cover the page it just opened.
    useEffect(() => {
        setMenuOpen(false);
    }, [route]);

    // Escape and a press outside both close it, which is what any popup owes a
    // user. The containment check keeps a click on a link *inside* the bar from
    // closing the drawer before the link's own click fires.
    useEffect(() => {
        if (!menuOpen) {
            return;
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                setMenuOpen(false);
            }
        };
        const onPress = (event: PointerEvent): void => {
            const target = event.target;
            if (target instanceof Node && barRef.current?.contains(target)) {
                return;
            }
            setMenuOpen(false);
        };
        window.addEventListener("keydown", onKey);
        window.addEventListener("pointerdown", onPress);
        return () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("pointerdown", onPress);
        };
    }, [menuOpen]);

    /** One page link, in whichever of the two lists is asking. */
    function link(to: AppRoute, label: string, className: string) {
        return (
            <AppLink
                key={to}
                to={to}
                className={className}
                current={route === to}
            >
                {label}
                {/* The count rides the Notifications link, wherever it shows.
                    While the drawer is open the hamburger's own badge is still
                    visible; that is the same number twice, not a second fact. */}
                {to === "notifications" && unread > 0 && (
                    <span className="navbar-badge">{unread}</span>
                )}
            </AppLink>
        );
    }

    return (
        <header className="navbar" ref={barRef}>
            <AppLink to="home" className="navbar-brand" label="Dashboard">
                JARVIS
            </AppLink>
            <nav className="navbar-links" aria-label="Pages">
                {LINKS.map((entry) =>
                    link(entry.to, entry.label, "navbar-link"),
                )}
            </nav>
            <span className="navbar-end">
                <ConnectionChip status={status} />
                {/* The account is the bar's on wide screens and the menu's on
                    narrow ones (#90 phase 6b): both are rendered, and the one
                    media query that hides the links hides this too. */}
                <span className="navbar-user">{username}</span>
                <button
                    type="button"
                    className="icon-btn navbar-menu"
                    aria-expanded={menuOpen}
                    aria-controls="navbar-drawer"
                    aria-label={menuOpen ? "Close menu" : "Menu"}
                    title={menuOpen ? "Close menu" : "Menu"}
                    onClick={() => setMenuOpen((open) => !open)}
                >
                    {menuOpen ? (
                        <X size={16} aria-hidden="true" />
                    ) : (
                        <Menu size={16} aria-hidden="true" />
                    )}
                    {unread > 0 && (
                        <span className="icon-badge" aria-hidden="true">
                            {unread}
                        </span>
                    )}
                </button>
            </span>
            {menuOpen && (
                <div id="navbar-drawer" className="navbar-drawer">
                    <p className="navbar-drawer-user">{username}</p>
                    <nav className="navbar-drawer-links" aria-label="Pages">
                        {LINKS.map((entry) =>
                            link(entry.to, entry.label, "navbar-drawer-link"),
                        )}
                    </nav>
                </div>
            )}
        </header>
    );
}
