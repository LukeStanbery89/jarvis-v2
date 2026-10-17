/**
 * The app's landing page (#90 phase 6a): a deliberately thin launcher — the
 * links to the app's pages and nothing that pretends to be more.
 *
 * The dashboard the plan calls for (clock, active timers and reminders, the
 * unread count) replaces this in phase 6b. Building it needs the shell that
 * owns the socket and the notification state, so this page exists to give `/`
 * the right destination *now* rather than to be the destination itself — which
 * is why it carries no widgets that the dashboard would have to unpick.
 *
 * The links are {@link AppLink}s: a click swaps the view in place. The admin
 * link stays a plain anchor on purpose — that is a different app on the server,
 * so it deserves a real navigation.
 */
import { AppLink } from "../AppLink";
import type { AppRoute } from "../router";

/** What the launcher offers, in the order it shows them. */
const PAGES: { to: AppRoute; label: string; note: string }[] = [
    { to: "chat", label: "Chat", note: "Talk to JARVIS" },
    {
        to: "timers",
        label: "Timers",
        note: "Countdowns that ring until stopped",
    },
    {
        to: "reminders",
        label: "Reminders",
        note: "Things to be told at a time you choose",
    },
    {
        to: "notifications",
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
                    <AppLink key={page.to} to={page.to} className="home-link">
                        <span className="home-link-label">{page.label}</span>
                        <span className="home-link-note">{page.note}</span>
                    </AppLink>
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
