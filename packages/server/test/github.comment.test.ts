/**
 * Comment references (#140).
 *
 * The relay model copies a `reply-to` URL out of a PR read; this turns it back
 * into the endpoint GitHub needs. The two fragment shapes are the whole
 * contract, so they are tested directly — including the bare fragment a model
 * may produce after trimming the URL.
 */
import { describe, expect, it } from "vitest";
import { parseCommentRef, quotedReply } from "../src/github/comment";

describe("parseCommentRef", () => {
    it("reads an inline review note", () => {
        expect(
            parseCommentRef(
                "https://github.com/LukeStanbery89/jarvis-v2/pull/165#discussion_r4333015888",
            ),
        ).toEqual({
            kind: "review",
            id: 4_333_015_888,
            url: "https://github.com/LukeStanbery89/jarvis-v2/pull/165#discussion_r4333015888",
        });
    });

    it("reads a conversation comment", () => {
        expect(
            parseCommentRef(
                "https://github.com/LukeStanbery89/jarvis-v2/pull/165#issuecomment-987",
            ),
        ).toEqual({
            kind: "issue",
            id: 987,
            url: "https://github.com/LukeStanbery89/jarvis-v2/pull/165#issuecomment-987",
        });
    });

    it("accepts a bare fragment, with no URL to quote", () => {
        expect(parseCommentRef("discussion_r42")).toEqual({
            kind: "review",
            id: 42,
            url: null,
        });
        expect(parseCommentRef("#issuecomment-7")).toEqual({
            kind: "issue",
            id: 7,
            url: null,
        });
    });

    it("refuses anything that is not a comment", () => {
        expect(
            parseCommentRef("https://github.com/luke/app/pull/165"),
        ).toBeNull();
        expect(parseCommentRef("the review thing")).toBeNull();
        expect(parseCommentRef("#discussion_r0")).toBeNull();
    });
});

describe("quotedReply", () => {
    it("quotes every line of the original above the reply", () => {
        expect(quotedReply("First line.\nSecond line.", "Done.")).toBe(
            "> First line.\n> Second line.\n\nDone.",
        );
    });
});
