/**
 * The structured answer form's markup (#180).
 *
 * Node-only, like the other view tests: render to static markup and assert the
 * controls a question of each kind produces. The interaction rules live in
 * `codingAnswers.test.ts`; this suite is about the surface the page renders.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodingJobQuestion } from "../../notifications";
import { CodingQuestionForm } from "./CodingQuestionForm";

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

describe("the structured answer form", () => {
    it("renders a control per question kind, plus Other", () => {
        const html = renderToStaticMarkup(
            createElement(CodingQuestionForm, {
                questions: [
                    question({ id: "text", text: "What should it say?" }),
                    question({
                        id: "single",
                        text: "Which mode?",
                        kind: "single",
                        options: [
                            { id: "a", label: "Mode A" },
                            { id: "b", label: "Mode B" },
                        ],
                        allowOther: true,
                    }),
                    question({
                        id: "multi",
                        text: "Which surfaces?",
                        kind: "multi",
                        options: [
                            { id: "rail", label: "Rail" },
                            { id: "bar", label: "Bar" },
                        ],
                        allowOther: true,
                        required: false,
                    }),
                ],
                onSubmit: async () => undefined,
            }),
        );

        expect(html).toContain("What should it say?");
        expect(html).toContain("<textarea");
        expect(html).toContain("Which mode?");
        expect(html).toContain('type="radio"');
        expect(html).toContain("Which surfaces?");
        expect(html).toContain('type="checkbox"');
        expect(html).toContain("Other");
        expect(html).toContain("Send answers");
        expect(html).toContain("*");
    });
});
