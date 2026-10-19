/**
 * The app's top bar (#90 phases 6b, 6d): the wordmark, the pages, the account,
 * and the state of the app — the connection, the microphone, the location share
 * — with the settings gear at the end of it.
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
 * **The state chips obey one rule: a chip renders only when it has something to
 * say.** That is why the connection chip is silent while connected, and why the
 * microphone and location chips are absent in their resting states — the bar is
 * not a dashboard of healthy subsystems. What it does show is exactly the states
 * a user must not have to go looking for: a dropped socket, an open microphone,
 * a share that is not delivering, and a voice session that failed. Phase 6d
 * brought the last three here with the gear, because the microphone and the
 * location share are the app's now and every page is a place they can be live.
 */
import { useEffect, useRef, useState } from "react";
import {
    ExternalLink,
    MapPin,
    Menu,
    Mic,
    Settings as SettingsIcon,
    X,
} from "lucide-react";
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

/**
 * The admin portal (#146 phase C).
 *
 * Not an `AppRoute`: `/admin` is a different SPA with its own router and its own
 * (cookie) sign-in, so this has to be a real anchor that unloads the app rather
 * than an `AppLink` that swaps a view. It is listed for every account: the web
 * app has never fetched the caller's `role`, and the portal is behind the
 * server's owner check anyway — a non-owner who follows the link meets the
 * portal's own refusal, which is a better answer than a menu that lies.
 */
const ADMIN_HREF = "/admin";

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
    /** Whether the settings panel is showing (the gear's `aria-expanded`). */
    settingsOpen: boolean;
    /** Opens the settings panel (the gear, wherever it is being rendered). */
    onOpenSettings(): void;
    /** The voice session's status line, or `null` when there is nothing to say. */
    voiceStatus: string | null;
    /** Whether the wake detector is live (a microphone that is on). */
    voiceListening: boolean;
    /** What the microphone is doing, for its tooltip (`describeWakeState`). */
    voiceLabel: string;
    /** A voice session that ended in failure, shown in place of the label. */
    voiceError: string | null;
    /** The location share's hint word, or `null` when there is nothing to say. */
    locationHint: string | null;
    /** The full sentence behind the hint (its tooltip). */
    locationSentence: string;
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
 * The microphone chip (#90 phase 6d): the wake detector, a running session, or a
 * session that failed — whichever is true, and absent when none is.
 *
 * The blink is the "live" part, exactly as it was in the sidebar: an armed
 * detector is an open microphone, and a static icon would read as decoration.
 * While a session is running its stage is the text, so the icon stops blinking
 * and speaks for itself ("Listening…" is a better answer than a pulse).
 */
function MicrophoneChip({
    listening,
    status,
    label,
    error,
}: {
    listening: boolean;
    status: string | null;
    label: string;
    error: string | null;
}) {
    if (!listening && status === null && error === null) {
        return null;
    }
    const title = error ?? label;
    return (
        <span
            className={error === null ? "navbar-state" : "navbar-state error"}
            role="status"
            title={title}
            aria-label={title}
        >
            <Mic
                size={14}
                className={
                    listening && status === null
                        ? "navbar-state-icon listening"
                        : "navbar-state-icon"
                }
                aria-hidden="true"
            />
            {status}
        </span>
    );
}

/**
 * The location chip (#90 phase 6d): what the share is doing, in a word.
 *
 * Present only while it is on and has something to say — "Locating…", or a
 * refusal the user should not have to open a panel to discover. The rotation
 * runs the same "how on earth is it delivering?" question the pin does
 * (`briefLocationState`), and the sentence behind the word is the tooltip.
 */
function LocationChip({
    hint,
    sentence,
}: {
    hint: string | null;
    sentence: string;
}) {
    if (hint === null) {
        return null;
    }
    return (
        <span
            className="navbar-state"
            role="status"
            title={sentence}
            aria-label={sentence}
        >
            <MapPin
                size={14}
                className="navbar-state-icon"
                aria-hidden="true"
            />
            {hint}
        </span>
    );
}

/**
 * The top bar.
 *
 * @param props - See {@link NavBarProps}.
 */
export function NavBar({
    username,
    unread,
    status,
    settingsOpen,
    onOpenSettings,
    voiceStatus,
    voiceListening,
    voiceLabel,
    voiceError,
    locationHint,
    locationSentence,
}: NavBarProps) {
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
                {/* A hairline, because Admin is a different kind of
                    destination: everything above it swaps a view, this leaves
                    the app. */}
                <span className="navbar-sep" aria-hidden="true" />
                <a
                    className="navbar-link navbar-external"
                    href={ADMIN_HREF}
                    title="Admin portal — a separate app"
                >
                    Admin
                    <ExternalLink size={11} aria-hidden="true" />
                </a>
            </nav>
            <span className="navbar-end">
                <ConnectionChip status={status} />
                <MicrophoneChip
                    listening={voiceListening}
                    status={voiceStatus}
                    label={voiceLabel}
                    error={voiceError}
                />
                <LocationChip hint={locationHint} sentence={locationSentence} />
                {/* The account is the bar's on wide screens and the menu's on
                    narrow ones (#90 phase 6b): both are rendered, and the one
                    media query that hides the links hides this too. */}
                <span className="navbar-user">{username}</span>
                <button
                    type="button"
                    className="icon-btn"
                    aria-expanded={settingsOpen}
                    aria-controls="settings-panel"
                    aria-label="Settings"
                    title="Settings"
                    onClick={onOpenSettings}
                >
                    <SettingsIcon size={16} aria-hidden="true" />
                </button>
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
                        <a
                            className="navbar-drawer-link navbar-external"
                            href={ADMIN_HREF}
                            title="Admin portal — a separate app"
                        >
                            Admin
                            <ExternalLink size={11} aria-hidden="true" />
                        </a>
                    </nav>
                </div>
            )}
        </header>
    );
}
