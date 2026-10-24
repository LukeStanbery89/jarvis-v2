/**
 * The "Navigation labels" appearance switch (#146 phase D).
 *
 * The suite is node-only and has no DOM, so the two surfaces the task names —
 * the top bar and the settings panel's Appearance group — are rendered to static
 * markup, the shape `JobsPages.test.ts` established. That is enough to catch
 * what this change can break: a bar link that lost its icon or its accessible
 * name once the visible word is hidden, and a panel that never grows the switch.
 *
 * The stylesheet is the third leg — it hides only `.navbar-links`
 * `.navbar-link-label`, so the drawer and the rail keep their words — and lives
 * in `styles.css` rather than here.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NavBar, type NavBarProps } from "./NavBar";
import { Settings, type SettingsProps } from "./Settings";

/** The bar's props, complete enough to render, overridable per test. */
function navbar(overrides: Partial<NavBarProps> = {}): NavBarProps {
    return {
        username: "luke",
        unread: 0,
        threadsOpen: false,
        onToggleThreads: () => undefined,
        status: "connected",
        settingsOpen: false,
        onOpenSettings: () => undefined,
        voiceStatus: null,
        voiceListening: false,
        voiceLabel: "Wake word off",
        voiceError: null,
        locationHint: null,
        locationSentence: "Location sharing is off",
        navLabels: true,
        ...overrides,
    };
}

/** The panel's props, complete enough to render, overridable per test. */
function settings(overrides: Partial<SettingsProps> = {}): SettingsProps {
    return {
        open: true,
        onClose: () => undefined,
        prefs: {},
        prefsLoaded: true,
        prefsSaving: false,
        prefsError: null,
        onPatchPrefs: () => undefined,
        browserNotifyAvailable: true,
        browserNotifyOn: false,
        browserNotifyLabel: "Desktop notifications are off",
        onToggleBrowserNotify: () => undefined,
        wakeAvailable: true,
        wakeOn: false,
        wakeArmed: false,
        onToggleWake: () => undefined,
        locationOn: false,
        locationState: "off",
        onToggleLocation: () => undefined,
        particlesOn: true,
        onToggleParticles: () => undefined,
        glassOn: true,
        onToggleGlass: () => undefined,
        navLabelsOn: true,
        onToggleNavLabels: () => undefined,
        onSignOut: () => undefined,
        ...overrides,
    };
}

describe("the navigation bar", () => {
    it("marks the bar with whichever way the preference is set", () => {
        expect(renderToStaticMarkup(createElement(NavBar, navbar()))).toContain(
            'data-nav-labels="on"',
        );
        expect(
            renderToStaticMarkup(
                createElement(NavBar, navbar({ navLabels: false })),
            ),
        ).toContain('data-nav-labels="off"');
    });

    it("gives every bar link an icon and its own label span", () => {
        // The icon is the bar's default (the task's "use icons by default");
        // the span is what the stylesheet hides when the preference is off.
        const html = renderToStaticMarkup(
            createElement(NavBar, navbar({ navLabels: false })),
        );

        expect(html.match(/navbar-link-icon/g)).toHaveLength(4);
        for (const label of ["Chat", "Timers", "Reminders", "Notifications"]) {
            expect(html).toContain('<span class="navbar-link-label">');
            expect(html).toContain(`>${label}</span>`);
        }
    });

    it("keeps every destination named for a screen reader and a pointer", () => {
        // `display: none` on the label would drop the word from the
        // accessibility tree, so the aria-label and the title carry it.
        const html = renderToStaticMarkup(
            createElement(NavBar, navbar({ navLabels: false })),
        );

        for (const label of ["Chat", "Timers", "Reminders", "Notifications"]) {
            expect(html).toContain(`aria-label="${label}"`);
            expect(html).toContain(`title="${label}"`);
        }
    });

    it("keeps Admin named when its word is the hidden one", () => {
        const html = renderToStaticMarkup(
            createElement(NavBar, navbar({ navLabels: false })),
        );

        expect(html).toContain('aria-label="Admin"');
        expect(html).toContain('title="Admin portal — a separate app"');
        expect(html).toContain('<span class="navbar-link-label">Admin</span>');
    });
});

describe("the Appearance settings", () => {
    it("offers the Navigation labels switch", () => {
        const html = renderToStaticMarkup(createElement(Settings, settings()));

        expect(html).toContain("Navigation labels");
    });

    it("describes the bar the preference asks for", () => {
        const on = renderToStaticMarkup(
            createElement(Settings, settings({ navLabelsOn: true })),
        );
        expect(on).toContain("links spell out their page.");

        const off = renderToStaticMarkup(
            createElement(Settings, settings({ navLabelsOn: false })),
        );
        expect(off).toContain("The top bar shows icons alone");
    });
});
