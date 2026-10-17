/**
 * The app's landing page (#90 phase 6a): a deliberately thin launcher — the
 * links to the app's pages and nothing that pretends to be more.
 *
 * The dashboard the plan calls for (clock, active timers and reminders, the
 * unread count) replaces this later. Building it needs the shell that owns the
 * socket and the notification state, so this page exists to give `/` the right
 * destination *now* rather than to be the destination itself — which is why it
 * carries no widgets that a later phase would have to unpick.
 *
 * The links are plain anchors: a click is a real navigation, the server's
 * fallback serves the shell for the target path, and the app boots on it. That
 * is the honest interim shape — a view swap with no reload needs the shell.
 */
import { ROUTE_PATHS } from "../router";

/** What the launcher offers, in the order it shows them. */
const PAGES: { href: string; label: string; note: string }[] = [
    { href: ROUTE_PATHS.chat, label: "Chat", note: "Talk to JARVIS" },
    {
        href: ROUTE_PATHS.timers,
        label: "Timers",
        note: "Countdowns that ring until stopped",
    },
    {
        href: ROUTE_PATHS.reminders,
        label: "Reminders",
        note: "Things to be told at a time you choose",
    },
    {
        href: ROUTE_PATHS.notifications,
        label: "Notifications",
        note: "What JARVIS has to report",
    },
];

/** Props for {@link Home}. */
export interface HomeProps {
    /** The signed-in account name. */
    username: string;
}

/**
 * The landing page.
 *
 * @param props - See {@link HomeProps}.
 */
export function Home({ username }: HomeProps) {
    return (
        <main className="home">
            <header className="home-header">
                <h1>JARVIS</h1>
                <p className="home-account">Signed in as {username}</p>
            </header>
            <nav className="home-links" aria-label="Pages">
                {PAGES.map((page) => (
                    <a key={page.href} href={page.href} className="home-link">
                        <span className="home-link-label">{page.label}</span>
                        <span className="home-link-note">{page.note}</span>
                    </a>
                ))}
            </nav>
            <p className="home-note">
                A dashboard (clock, active timers and reminders) will live here
                instead. The server&apos;s admin portal is at{" "}
                <a href="/admin">/admin</a>.
            </p>
        </main>
    );
}
