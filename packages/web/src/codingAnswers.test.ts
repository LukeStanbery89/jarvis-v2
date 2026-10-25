/**
 * The pure half of the structured answer form (#180).
 *
 * The form's React state is deliberately thin; these helpers own the rules the
 * tests care about — what counts as complete, and how a draft becomes the
 * payload the REST route accepts.
 */
import { describe, expect, it } from "vitest";
import {
    codingAnswersFromDraft,
    codingDraftComplete,
    describeCodingAnswer,
    emptyCodingDraft,
} from "./codingAnswers";
import type { CodingJobQuestion } from "./notifications";

/** One stored question, with every field decided. */
function question(
    overrides: Partial<CodingJobQuestion> = {},
): CodingJobQuestion {
    return {
        id: "q1",
        text: "Which one?",
        kind: "text",
        options: [],
        required: true,
        allowOther: false,
        position: 0,
        answer: null,
        answeredAt: null,
        answerSource: null,
        ...overrides,
    };
}

describe("structured answer drafts (#180)", () => {
    it("prefills from answers the job already carries", () => {
        const questions: CodingJobQuestion[] = [
            question({
                id: "db",
                kind: "single",
                options: [
                    { id: "postgres", label: "Postgres" },
                    { id: "sqlite", label: "SQLite" },
                ],
                answer: { questionId: "db", value: "postgres" },
            }),
            question({
                id: "surfaces",
                kind: "multi",
                options: [
                    { id: "rail", label: "Rail" },
                    { id: "bar", label: "Bar" },
                ],
                answer: { questionId: "surfaces", value: ["rail"] },
            }),
            question({
                id: "notes",
                required: false,
                answer: { questionId: "notes", value: "Keep Admin." },
            }),
        ];

        expect(emptyCodingDraft(questions)).toEqual({
            db: { value: "postgres", values: [], other: "" },
            surfaces: { value: "", values: ["rail"], other: "" },
            notes: { value: "Keep Admin.", values: [], other: "" },
        });
    });

    it("requires every required question, including Other text", () => {
        const text = question({ id: "text" });
        const single = question({
            id: "single",
            kind: "single",
            options: [{ id: "a", label: "A" }],
            allowOther: true,
        });
        const multi = question({
            id: "multi",
            kind: "multi",
            options: [{ id: "a", label: "A" }],
            allowOther: true,
        });
        const optional = question({ id: "optional", required: false });
        const questions = [text, single, multi, optional];
        const draft = emptyCodingDraft(questions);

        expect(codingDraftComplete(questions, draft)).toBe(false);
        draft.text = { value: "hello", values: [], other: "" };
        draft.single = { value: "a", values: [], other: "" };
        draft.multi = { value: "", values: [], other: "a note" };
        expect(codingDraftComplete(questions, draft)).toBe(true);

        draft.single = { value: "other", values: [], other: "" };
        expect(codingDraftComplete(questions, draft)).toBe(false);
        draft.single = { value: "other", values: [], other: "something" };
        expect(codingDraftComplete(questions, draft)).toBe(true);

        draft.text = { value: "   ", values: [], other: "" };
        expect(codingDraftComplete(questions, draft)).toBe(false);
    });

    it("builds text, single, single-Other, and multi answers", () => {
        const questions: CodingJobQuestion[] = [
            question({ id: "text" }),
            question({
                id: "single",
                kind: "single",
                options: [{ id: "a", label: "A" }],
                allowOther: true,
            }),
            question({
                id: "multi",
                kind: "multi",
                options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                ],
                allowOther: true,
            }),
            question({ id: "optional", required: false }),
        ];
        const draft = emptyCodingDraft(questions);
        draft.text = { value: " hello ", values: [], other: "" };
        draft.single = { value: "other", values: [], other: " custom " };
        draft.multi = {
            value: "",
            values: ["a", "b"],
            other: " extra ",
        };

        expect(codingAnswersFromDraft(questions, draft)).toEqual([
            { questionId: "text", value: "hello" },
            { questionId: "single", value: "other", other: "custom" },
            {
                questionId: "multi",
                value: ["a", "b"],
                other: "extra",
            },
        ]);
    });

    it("describes a stored answer in the question's own terms", () => {
        const single = question({
            id: "db",
            kind: "single",
            options: [
                { id: "postgres", label: "Postgres" },
                { id: "sqlite", label: "SQLite" },
            ],
            answer: { questionId: "db", value: "postgres" },
        });
        expect(describeCodingAnswer(single)).toBe("Postgres");

        const other = question({
            id: "db",
            kind: "single",
            options: [{ id: "postgres", label: "Postgres" }],
            allowOther: true,
            answer: {
                questionId: "db",
                value: "other",
                other: "MySQL",
            },
        });
        expect(describeCodingAnswer(other)).toBe("Other: MySQL");

        const multi = question({
            id: "surfaces",
            kind: "multi",
            options: [
                { id: "rail", label: "Rail" },
                { id: "bar", label: "Bar" },
            ],
            allowOther: true,
            answer: {
                questionId: "surfaces",
                value: ["rail", "bar"],
                other: "Drawer",
            },
        });
        expect(describeCodingAnswer(multi)).toBe("Rail, Bar — Other: Drawer");

        expect(describeCodingAnswer(question({ id: "notes" }))).toBe(
            "Not answered.",
        );
    });
});
