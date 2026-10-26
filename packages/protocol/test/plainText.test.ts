import { describe, expect, it } from "vitest";
import { plainText } from "../src/plainText";

describe("plainText", () => {
    it("turns a scheduled brief's headings, bold and numbered lists into readable lines", () => {
        const markdown = [
            "## Morning brief",
            "",
            "**Canada**: A major fire at a military base.",
            "",
            "1. **Oil Markets**: Oil prices dipped after the announcement.",
            "2. **Ukraine**: SpaceX has throttled Starlink.",
        ].join("\n");

        expect(plainText(markdown)).toBe(
            [
                "Morning brief",
                "",
                "Canada: A major fire at a military base.",
                "",
                "• Oil Markets: Oil prices dipped after the announcement.",
                "• Ukraine: SpaceX has throttled Starlink.",
            ].join("\n"),
        );
    });

    it("keeps link labels, falls back to the URL, and keeps image alt text", () => {
        expect(
            plainText(
                "[the story](https://example.com/story) and [](https://example.com/raw)",
            ),
        ).toBe("the story and https://example.com/raw");
        expect(plainText("![weather map](https://example.com/map.png)")).toBe(
            "weather map",
        );
    });

    it("strips inline code, code fences, blockquotes and emphasis", () => {
        expect(
            plainText(
                "> **Note**\n\nUse `npm test`.\n\n```ts\nconst answer = 42;\n```\n\n*Done.*",
            ),
        ).toBe("Note\n\nUse npm test.\n\nconst answer = 42;\n\nDone.");
    });

    it("leaves identifiers with underscores intact", () => {
        expect(plainText("Set `snake_case_name` in the file.")).toBe(
            "Set snake_case_name in the file.",
        );
        expect(plainText("_italic_ and **bold**")).toBe("italic and bold");
    });

    it("drops raw HTML tags and escapes", () => {
        expect(plainText("<strong>Hello</strong> &amp; welcome")).toBe(
            "Hello & welcome",
        );
    });

    it("returns an empty string for formatting with no text", () => {
        expect(plainText("** **")).toBe("");
        expect(plainText("---")).toBe("");
    });
});
