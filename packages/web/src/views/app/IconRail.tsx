/**
 * The navigation rail (#146 phase D): a column of destinations on a display wide
 * enough to spend one.
 *
 * It is the wide-screen form of the list the bar already carries — the
 * destinations do not change, only their shape — and it appears at 80rem, where
 * the bar's links would otherwise sit a long way from the content they swap.
 * Below that the bar keeps them (from 60rem, its measured breakpoint) and the
 * hamburger carries them (under 60rem), so there is exactly one set of
 * destinations at every width.
 *
 * The **Navigation labels** preference is the rail's own (#177): on, every item
 * is its icon beside its word; off, the word is hidden and the icon stands
 * alone. Because `display: none` would take the word out of the accessibility
 * tree, every item keeps a real `aria-label` plus a `title` for the pointer, so
 * it is named in both modes. The switch reaches only this component — the bar,
 * the drawer and the hamburger are not in its scope. The unread badge is the
 * bar's own (`.navbar-badge`), moved onto the icon's corner
 * (`.rail-link-icon`) — the same number in the same place, whichever affordance
 * is showing it.
 */
import {
    Bell,
    BellRing,
    ExternalLink,
    House,
    MessagesSquare,
    Timer,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppLink } from "../../AppLink";
import { useRoute } from "../../hooks/useRoute";
import type { AppRoute } from "../../router";
import { ADMIN_HREF } from "./NavBar";

/** The rail's destinations, in the bar's order (the dashboard first). */
const ITEMS: { to: AppRoute; label: string; Icon: LucideIcon }[] = [
    { to: "home", label: "Dashboard", Icon: House },
    { to: "chat", label: "Chat", Icon: MessagesSquare },
    { to: "timers", label: "Timers", Icon: Timer },
    { to: "reminders", label: "Reminders", Icon: BellRing },
    { to: "notifications", label: "Notifications", Icon: Bell },
];

/** Props for {@link IconRail}. */
export interface IconRailProps {
    /** Notifications neither read nor dismissed (the badge). */
    unread: number;
    /** Whether each item shows its word beside its icon (the appearance switch). */
    navLabels: boolean;
}

/**
 * The wide-screen navigation rail, rendered by {@link AppShell} beside the view.
 *
 * Hidden by CSS below its breakpoint rather than by a width probe, so the
 * server-rendered and first-paint layouts agree with the stylesheet. Whether the
 * words show is `data-nav-labels` on the nav, so the flip is one attribute the
 * stylesheet reads and the markup is the same in both modes.
 *
 * @param props - See {@link IconRailProps}.
 */
export function IconRail({ unread, navLabels }: IconRailProps) {
    const route = useRoute();
    return (
        <nav
            className="rail"
            aria-label="Pages"
            data-nav-labels={navLabels ? "on" : "off"}
        >
            {ITEMS.map(({ to, label, Icon }) => (
                <AppLink
                    key={to}
                    to={to}
                    className="rail-link"
                    label={label}
                    title={label}
                    current={route === to}
                >
                    <span className="rail-link-icon">
                        <Icon size={18} aria-hidden="true" />
                        {to === "notifications" && unread > 0 && (
                            <span className="navbar-badge rail-badge">
                                {unread}
                            </span>
                        )}
                    </span>
                    <span className="rail-link-label">{label}</span>
                </AppLink>
            ))}
            {/* Admin is not a page of this app (#146 phase C): it leaves for the
                portal, so it sits past the same hairline the bar uses. */}
            <span className="rail-sep" aria-hidden="true" />
            <a
                className="rail-link rail-external"
                href={ADMIN_HREF}
                title="Admin portal — a separate app"
                aria-label="Admin"
            >
                <span className="rail-link-icon">
                    <ExternalLink size={18} aria-hidden="true" />
                </span>
                <span className="rail-link-label">Admin</span>
            </a>
        </nav>
    );
}
