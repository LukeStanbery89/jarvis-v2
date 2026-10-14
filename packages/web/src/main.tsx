/**
 * The web client's entry point.
 *
 * Renders the chat client, or — when `?voice-harness=1` is present — the
 * offline wake→command replay harness (#121) instead. The harness is lazily
 * imported, so it is code-split out of the normal bundle and a regular page
 * load never downloads it.
 */
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

/** The dev-only replay harness, loaded only when its flag is set. */
const VoiceHarness = lazy(() => import("./dev/VoiceHarness"));

/**
 * Whether the harness was requested for this page load.
 *
 * @param search - The location search string.
 * @returns True when `?voice-harness=1` is present.
 */
function harnessRequested(search: string): boolean {
    return new URLSearchParams(search).get("voice-harness") === "1";
}

/** The root surface: the harness when asked for, the chat client otherwise. */
function Surface() {
    if (!harnessRequested(window.location.search)) {
        return <App />;
    }
    return (
        <Suspense
            fallback={
                <p style={{ fontFamily: "monospace", padding: 16 }}>
                    Loading voice harness…
                </p>
            }
        >
            <VoiceHarness />
        </Suspense>
    );
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Surface />
    </StrictMode>,
);
