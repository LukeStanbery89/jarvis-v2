/**
 * GitHub issue reference tests (#140).
 *
 * The parser is the hinge between a URL the user shared and the number the
 * coding service reads. Two failures matter: accepting a pull-request URL as
 * an issue, and guessing when a message names two issues. Both are pinned
 * here, along with the short forms a model copies.
 */
import { describe, expect, it } from "vitest";
import { issueRefFromPrompt, parseIssueRef } from "../src/github/issue";

describe("parseIssueRef", () => {
    it("accepts a bare number or its hash form", () => {
        expect(parseIssueRef(157)).toEqual({ number: 157 });
        expect(parseIssueRef("157")).toEqual({ number: 157 });
        expect(parseIssueRef("#157")).toEqual({ number: 157 });
    });

    it("accepts an issue URL and names its repository", () => {
        expect(parseIssueRef("https://github.com/luke/app/issues/157")).toEqual(
            { number: 157, repo: "luke/app" },
        );
        expect(
            parseIssueRef(
                "https://github.com/luke/app/issues/157#issuecomment-987",
            ),
        ).toEqual({ number: 157, repo: "luke/app" });
        expect(
            parseIssueRef("https://github.com/luke/app/issues/157?foo=bar"),
        ).toEqual({ number: 157, repo: "luke/app" });
    });

    it("refuses a pull request, a non-GitHub URL, and junk", () => {
        expect(
            parseIssueRef("https://github.com/luke/app/pull/157"),
        ).toBeNull();
        expect(
            parseIssueRef("https://gitlab.com/luke/app/issues/157"),
        ).toBeNull();
        expect(parseIssueRef("the issue about the modal")).toBeNull();
        expect(parseIssueRef("")).toBeNull();
        expect(parseIssueRef(0)).toBeNull();
        expect(parseIssueRef(-1)).toBeNull();
    });
});

describe("issueRefFromPrompt", () => {
    it("finds the one issue a shared message names", () => {
        expect(
            issueRefFromPrompt(
                "Implement this: https://github.com/luke/app/issues/157",
            ),
        ).toEqual({ number: 157, repo: "luke/app" });
        // Repeating the same link is still one reference.
        expect(
            issueRefFromPrompt(
                "https://github.com/luke/app/issues/157 and https://github.com/luke/app/issues/157",
            ),
        ).toEqual({ number: 157, repo: "luke/app" });
    });

    it("refuses ambiguity and pull requests", () => {
        expect(
            issueRefFromPrompt(
                "https://github.com/luke/app/issues/157 or https://github.com/luke/app/issues/158",
            ),
        ).toBeNull();
        expect(
            issueRefFromPrompt(
                "https://github.com/luke/app/issues/157 and https://github.com/luke/app/pull/165",
            ),
        ).toBeNull();
        expect(
            issueRefFromPrompt("https://github.com/luke/app/pull/165"),
        ).toBeNull();
        expect(issueRefFromPrompt("Implement issue #157.")).toBeNull();
        expect(issueRefFromPrompt("")).toBeNull();
    });
});
