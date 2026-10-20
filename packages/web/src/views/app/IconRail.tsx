/**
 * The icon rail (#146 phase D): a column of destinations on a display wide
 * enough to spend one.
 *
 * It is the wide-screen form of the list the bar already carries — the
 * destinations do not change, only their shape — and it appears at 80rem, where
 * the bar's links would otherwise sit a long way from the content they swap.
 * Below that the bar keeps them (from 60rem, its measured breakpoint) and the
 * hamburger carries them (under 60rem), so there is exactly one set of
 * destinations at every width.
 *
 * Icon-only, so every item is a real `aria-label` plus a `title` for the
 * pointer: the rail is the one place in the app where a destination has no
 * visible word. The unread badge is the bar's own (`.navbar-badge`), moved onto
 * the item's corner — the same number in the same place, whichever affordance is
 * showing it.
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
}

/**
 * The wide-screen navigation rail, rendered by {@link AppShell} beside the view.
 *
 * Hidden by CSS below its breakpoint rather than by a width probe, so the
 * server-rendered and first-paint layouts agree with the stylesheet.
 *
 * @param props - See {@link IconRailProps}.
 */
export function IconRail({ unread }: IconRailProps) {
    const route = useRoute();
    return (
        <nav className="rail" aria-label="Pages">
            {ITEMS.map(({ to, label, Icon }) => (
                <AppLink
                    key={to}
                    to={to}
                    className="rail-link"
                    label={label}
                    title={label}
                    current={route === to}
                >
                    <Icon size={18} aria-hidden="true" />
                    {to === "notifications" && unread > 0 && (
                        <span className="navbar-badge rail-badge">
                            {unread}
                        </span>
                    )}
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
                <ExternalLink size={18} aria-hidden="true" />
            </a>
        </nav>
    );
}
