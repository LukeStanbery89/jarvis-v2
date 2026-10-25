/**
 * The SDLC artifact reader (#94, #180).
 *
 * The agent writes `.jarvis/plan.md` and `.jarvis/questions.json`; the
 * supervisor reads them, posts the questions and deletes the directory before
 * any host git command. This suite is about the reading half: shapes a small
 * model might write, the caps, the structured question kinds, and the
 * malformed-file fallback that keeps an ask from vanishing.
 */
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    clearJobArtifacts,
    JOB_ARTIFACT_DIR,
    readJobArtifacts,
} from "../src/sandbox/artifacts";

const dirs: string[] = [];

/** A fresh workspace directory. */
function workspace(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "jarvis-artifacts-"));
    dirs.push(dir);
    return dir;
}

/** Writes the artifact directory, with either file omitted when null. */
function write(root: string, plan: string | null, questions: unknown): void {
    const dir = path.join(root, JOB_ARTIFACT_DIR);
    mkdirSync(dir, { recursive: true });
    if (plan !== null) {
        writeFileSync(path.join(dir, "plan.md"), plan);
    }
    if (questions !== null) {
        writeFileSync(
            path.join(dir, "questions.json"),
            typeof questions === "string"
                ? questions
                : JSON.stringify(questions),
        );
    }
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("job artifacts", () => {
    it("reads a plan and a list of string questions", async () => {
        const root = workspace();
        write(root, "Plan: one file.", {
            questions: ["Which DB?", "Which port?"],
        });

        expect(await readJobArtifacts(root)).toEqual({
            plan: "Plan: one file.",
            questions: ["Which DB?", "Which port?"],
            structuredQuestions: [
                {
                    id: "q1",
                    text: "Which DB?",
                    kind: "text",
                    options: [],
                    required: true,
                    allowOther: false,
                },
                {
                    id: "q2",
                    text: "Which port?",
                    kind: "text",
                    options: [],
                    required: true,
                    allowOther: false,
                },
            ],
        });
    });

    it("accepts the object shapes a small model writes", async () => {
        const root = workspace();
        write(root, "Plan.", {
            questions: [
                { question: "Which DB?" },
                { text: "Which port?" },
                "",
                4,
            ],
        });

        expect(await readJobArtifacts(root)).toEqual({
            plan: "Plan.",
            questions: ["Which DB?", "Which port?"],
            structuredQuestions: [
                {
                    id: "q1",
                    text: "Which DB?",
                    kind: "text",
                    options: [],
                    required: true,
                    allowOther: false,
                },
                {
                    id: "q2",
                    text: "Which port?",
                    kind: "text",
                    options: [],
                    required: true,
                    allowOther: false,
                },
            ],
        });
    });

    it("reads single- and multiple-choice questions", async () => {
        const root = workspace();
        write(root, "Plan.", {
            questions: [
                {
                    id: "rail-labels",
                    text: "Should the rail show labels?",
                    kind: "single",
                    options: [
                        { id: "labels", label: "Icon + label" },
                        { id: "icons", label: "Icon only" },
                    ],
                    required: true,
                    allowOther: false,
                },
                {
                    id: "surfaces",
                    text: "Which surfaces?",
                    kind: "multi",
                    options: ["rail", "bar"],
                    required: false,
                    allowOther: true,
                },
                {
                    id: "notes",
                    text: "Anything else?",
                    kind: "text",
                    required: false,
                },
            ],
        });

        expect(await readJobArtifacts(root)).toEqual({
            plan: "Plan.",
            questions: [
                "Should the rail show labels?",
                "Which surfaces?",
                "Anything else?",
            ],
            structuredQuestions: [
                {
                    id: "rail-labels",
                    text: "Should the rail show labels?",
                    kind: "single",
                    options: [
                        { id: "labels", label: "Icon + label" },
                        { id: "icons", label: "Icon only" },
                    ],
                    required: true,
                    allowOther: false,
                },
                {
                    id: "surfaces",
                    text: "Which surfaces?",
                    kind: "multi",
                    options: [
                        { id: "opt1", label: "rail" },
                        { id: "opt2", label: "bar" },
                    ],
                    required: false,
                    allowOther: true,
                },
                {
                    id: "notes",
                    text: "Anything else?",
                    kind: "text",
                    options: [],
                    required: false,
                    allowOther: false,
                },
            ],
        });
    });

    it("infers single choice when options are present without a kind", async () => {
        const root = workspace();
        write(root, null, {
            questions: [
                {
                    text: "Which one?",
                    options: ["A", "B"],
                },
            ],
        });

        const artifacts = await readJobArtifacts(root);
        expect(artifacts.structuredQuestions[0]).toMatchObject({
            kind: "single",
            options: [
                { id: "opt1", label: "A" },
                { id: "opt2", label: "B" },
            ],
        });
    });

    it("downgrades a choice with no usable options to text", async () => {
        const root = workspace();
        write(root, null, {
            questions: [
                {
                    id: "no-options",
                    text: "Which one?",
                    kind: "single",
                    options: [],
                },
            ],
        });

        const artifacts = await readJobArtifacts(root);
        expect(artifacts.structuredQuestions[0]).toMatchObject({
            kind: "text",
            options: [],
        });
    });

    it("keeps ids unique within the set and within a question", async () => {
        const root = workspace();
        write(root, null, {
            questions: [
                { id: "same", text: "First?" },
                { id: "same", text: "Second?" },
                {
                    id: "same",
                    text: "Third?",
                    kind: "single",
                    options: [
                        { id: "x", label: "X" },
                        { id: "x", label: "Y" },
                    ],
                },
            ],
        });

        const artifacts = await readJobArtifacts(root);
        expect(artifacts.structuredQuestions.map((q) => q.id)).toEqual([
            "same",
            "same-2",
            "same-3",
        ]);
        expect(
            artifacts.structuredQuestions[2]?.options.map((o) => o.id),
        ).toEqual(["x", "x-2"]);
    });

    it("bounds question text, choices, and choice labels", async () => {
        const root = workspace();
        write(root, null, {
            questions: [
                {
                    text: "Q".repeat(2500),
                    kind: "single",
                    options: Array.from(
                        { length: 25 },
                        (_, i) => "L".repeat(i === 0 ? 250 : 100) + i,
                    ),
                },
            ],
        });

        const artifacts = await readJobArtifacts(root);
        const question = artifacts.structuredQuestions[0];
        expect(question?.text).toHaveLength(2000);
        expect(question?.options).toHaveLength(20);
        expect(question?.options[0]?.label).toHaveLength(200);
    });

    it("turns an unparseable questions file into one question", async () => {
        const root = workspace();
        write(root, null, "I need to know which database to use.");

        const artifacts = await readJobArtifacts(root);
        expect(artifacts.questions).toHaveLength(1);
        expect(artifacts.questions[0]).toContain("which database");
        expect(artifacts.structuredQuestions).toEqual([
            {
                id: "q1",
                text: "I need to know which database to use.",
                kind: "text",
                options: [],
                required: true,
                allowOther: false,
            },
        ]);
    });

    it("returns no questions when the file is absent", async () => {
        const root = workspace();
        write(root, "Plan only.", null);

        expect(await readJobArtifacts(root)).toEqual({
            plan: "Plan only.",
            questions: [],
            structuredQuestions: [],
        });
    });

    it("caps the number of questions", async () => {
        const root = workspace();
        write(root, null, {
            questions: Array.from({ length: 30 }, (_, i) => `Q${i + 1}?`),
        });

        const artifacts = await readJobArtifacts(root);
        expect(artifacts.questions).toHaveLength(20);
        expect(artifacts.questions[19]).toBe("Q20?");
        expect(artifacts.structuredQuestions).toHaveLength(20);
    });

    it("deletes the artifact directory", async () => {
        const root = workspace();
        write(root, "Plan.", { questions: ["Q?"] });

        await clearJobArtifacts(root);

        expect(existsSync(path.join(root, JOB_ARTIFACT_DIR))).toBe(false);
    });
});
