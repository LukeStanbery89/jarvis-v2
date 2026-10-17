/**
 * A page that exists but has nothing in it yet (#90 phase 6a).
 *
 * The launcher's destinations are real from the first day (`/timers`,
 * `/reminders`, `/notifications`), so a link never lands on the chat or on
 * nothing at all. The lists themselves arrive with the pages phase; saying so
 * plainly beats an empty box that reads as broken, and it keeps the app's URL
 * shape settled while the content catches up.
 */
import { ROUTE_PATHS } from "../router";

/** Props for {@link PagePlaceholder}. */
export interface PagePlaceholderProps {
    /** The page's name, as the nav and the launcher spell it. */
    title: string;
    /** What the page will do, in one line. */
    note: string;
}

/**
 * The under-construction page.
 *
 * @param props - See {@link PagePlaceholderProps}.
 */
export function PagePlaceholder({ title, note }: PagePlaceholderProps) {
    return (
        <main className="page-placeholder">
            <h1>{title}</h1>
            <p className="page-placeholder-note">{note}</p>
            <p className="page-placeholder-state">
                This page is not built yet — it arrives in the next phase.
            </p>
            <p className="page-placeholder-links">
                <a href={ROUTE_PATHS.home}>← Home</a>
                {" · "}
                <a href={ROUTE_PATHS.chat}>Chat</a>
            </p>
        </main>
    );
}
