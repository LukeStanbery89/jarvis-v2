/**
 * The SDLC artifact reader (#94).
 *
 * The agent writes `.jarvis/plan.md` and `.jarvis/questions.json`; the
 * supervisor reads them, posts the questions and deletes the directory before
 * any host git command. This suite is about the reading half: shapes a small
 * model might write, the caps, and the malformed-file fallback that keeps an
 * ask from vanishing.
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
        });
    });

    it("turns an unparseable questions file into one question", async () => {
        const root = workspace();
        write(root, null, "I need to know which database to use.");

        const artifacts = await readJobArtifacts(root);
        expect(artifacts.questions).toHaveLength(1);
        expect(artifacts.questions[0]).toContain("which database");
    });

    it("returns no questions when the file is absent", async () => {
        const root = workspace();
        write(root, "Plan only.", null);

        expect(await readJobArtifacts(root)).toEqual({
            plan: "Plan only.",
            questions: [],
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
    });

    it("deletes the artifact directory", async () => {
        const root = workspace();
        write(root, "Plan.", { questions: ["Q?"] });

        await clearJobArtifacts(root);

        expect(existsSync(path.join(root, JOB_ARTIFACT_DIR))).toBe(false);
    });
});
