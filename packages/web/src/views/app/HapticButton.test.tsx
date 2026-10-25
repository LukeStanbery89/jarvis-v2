/**
 * The server-rendered half of `HapticButton` (#189 follow-up).
 *
 * The native-switch overlay only exists in a browser after layout, so the
 * static render is the contract that matters here: adding haptics must leave an
 * ordinary `<button>` with its type, classes, disabled state, and children for
 * every caller, and must not emit a stray portal.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HapticButton } from "./HapticButton";

describe("HapticButton", () => {
    it("renders the real button when no haptics shell is present", () => {
        const html = renderToStaticMarkup(
            createElement(
                HapticButton,
                { className: "send active", disabled: true },
                "Send",
            ),
        );
        expect(html).toContain("<button");
        expect(html).toContain('type="button"');
        expect(html).toContain('class="send active"');
        expect(html).toContain("disabled");
        expect(html).toContain(">Send</button>");
        expect(html).not.toContain("haptic-switch-hit");
    });
});
