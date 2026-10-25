/**
 * The "Navigation labels" appearance switch (#146 phase D, #177).
 *
 * The suite is node-only and has no DOM, so the two named surfaces — the
 * wide-screen left menu (`IconRail`) and the settings panel's Appearance group —
 * are rendered to static markup, the shape `JobsPages.test.ts` established. That
 * is enough to catch what this change can break: a rail item that loses its
 * label span, its icon, or its accessible name once the word is hidden, and a
 * panel that never grows the switch.
 *
 * The stylesheet is the third leg — it hides only `.rail-link-label`, so the bar,
 * the drawer and the hamburger keep their words, and hides `.settings-nav-labels`
 * below the rail's own 80 rem breakpoint, so the switch is not offered where the
 * rail it controls is absent. Both live in `styles.css` rather than here.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconRail, type IconRailProps } from "./IconRail";
import { Settings, type SettingsProps } from "./Settings";

/** The rail's destinations, in its own order. */
const RAIL_LABELS = [
    "Dashboard",
    "Chat",
    "Timers",
    "Reminders",
    "Notifications",
    "Settings",
];

/** The rail's props, complete enough to render, overridable per test. */
function rail(overrides: Partial<IconRailProps> = {}): IconRailProps {
    return {
        unread: 0,
        navLabels: true,
        settingsOpen: false,
        onOpenSettings: () => undefined,
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
        browserNotifyLabel: "System notifications are off",
        onToggleBrowserNotify: () => undefined,
        wakeAvailable: true,
        wakeOn: false,
        wakeArmed: false,
        onToggleWake: () => undefined,
        locationOn: false,
        locationState: "off",
        onToggleLocation: () => undefined,
        hapticsAvailable: true,
        hapticsOn: true,
        onToggleHaptics: () => undefined,
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

describe("the wide-screen left menu", () => {
    it("marks the rail with whichever way the preference is set", () => {
        expect(renderToStaticMarkup(createElement(IconRail, rail()))).toContain(
            'data-nav-labels="on"',
        );
        expect(
            renderToStaticMarkup(
                createElement(IconRail, rail({ navLabels: false })),
            ),
        ).toContain('data-nav-labels="off"');
    });

    it("gives every destination an icon and its own label span", () => {
        const html = renderToStaticMarkup(createElement(IconRail, rail()));

        expect(html.match(/<span class="rail-link-icon">/g)).toHaveLength(7);
        for (const label of [...RAIL_LABELS, "Admin"]) {
            expect(html).toContain(
                `<span class="rail-link-label">${label}</span>`,
            );
        }
    });

    it("keeps the label in the markup when the switch is off", () => {
        // The stylesheet hides the span; the markup is the same in both modes,
        // so the flip is one `data-nav-labels` attribute rather than a second
        // render path.
        const html = renderToStaticMarkup(
            createElement(IconRail, rail({ navLabels: false })),
        );

        for (const label of [...RAIL_LABELS, "Admin"]) {
            expect(html).toContain(
                `<span class="rail-link-label">${label}</span>`,
            );
        }
    });

    it("keeps every destination named for a screen reader and a pointer", () => {
        // `display: none` on the label would drop the word from the
        // accessibility tree, so the aria-label and the title carry it.
        const html = renderToStaticMarkup(
            createElement(IconRail, rail({ navLabels: false })),
        );

        for (const label of RAIL_LABELS) {
            expect(html).toContain(`aria-label="${label}"`);
            expect(html).toContain(`title="${label}"`);
        }
        // Admin's title is the sentence behind the link, not its name.
        expect(html).toContain('aria-label="Admin"');
        expect(html).toContain('title="Admin portal — a separate app"');
    });

    it("keeps the unread badge on the notifications icon", () => {
        const html = renderToStaticMarkup(
            createElement(IconRail, rail({ unread: 3 })),
        );

        expect(html).toContain("rail-link-icon");
        expect(html).toContain("rail-badge");
        expect(html).toContain(">3<");
    });

    it("puts Settings under Notifications and exposes the panel state", () => {
        // Settings is a menu item, not a destination (#177 follow-up): it
        // follows Notifications, stays above the Admin hairline, and reports
        // whether the dialog it opens is showing.
        const html = renderToStaticMarkup(
            createElement(IconRail, rail({ settingsOpen: true })),
        );

        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain('aria-controls="settings-panel"');
        expect(html.indexOf(">Notifications<")).toBeLessThan(
            html.indexOf(">Settings<"),
        );
        expect(html.indexOf(">Settings<")).toBeLessThan(
            html.indexOf("rail-sep"),
        );
    });
});

describe("the Appearance settings", () => {
    it("offers the Navigation labels switch", () => {
        const html = renderToStaticMarkup(createElement(Settings, settings()));

        expect(html).toContain("Navigation labels");
    });

    it("describes the left menu the preference asks for", () => {
        const on = renderToStaticMarkup(
            createElement(Settings, settings({ navLabelsOn: true })),
        );
        expect(on).toContain("left menu spells out its pages");

        const off = renderToStaticMarkup(
            createElement(Settings, settings({ navLabelsOn: false })),
        );
        expect(off).toContain("left menu shows icons alone");
    });

    it("marks the switch for hiding below the rail's breakpoint", () => {
        // The rail is `display: none` below 80 rem, so the control is inert
        // there (#177 review). Both the row and its note carry the class the
        // stylesheet hides at that breakpoint; a node render cannot evaluate a
        // media query, so this proves the hook the rule keys on.
        const html = renderToStaticMarkup(createElement(Settings, settings()));

        expect(html).toContain('class="settings-row settings-nav-labels"');
        expect(html).toContain('class="settings-note settings-nav-labels"');
    });
});
