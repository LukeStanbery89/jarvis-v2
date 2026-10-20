/**
 * Workspace tests (#141).
 *
 * These run real `git` against a real `file://` origin, because the thing being
 * tested *is* a sequence of git commands — a fake would only assert that the
 * manager calls the fake. The origin is a temporary repository, so nothing
 * leaves the machine and no credential is involved.
 *
 * The two refusals matter as much as the clone: a repository outside the
 * allowlist must not be preparable, and `remove` must never delete anything
 * outside the root it owns (a corrupt row names a path; the manager must not
 * trust it).
 */
import { execFileSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
    existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    createWorkspaceManager,
    parseRepoEntry,
    sweepWorkspaces,
} from "../src/sandbox/workspace";

/** Every temp directory a test made, swept afterwards. */
const tempDirs: string[] = [];

/** Creates a temp directory that the suite removes later. */
function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** Runs git in a directory with an identity, so commits work anywhere. */
function git(args: string[], cwd: string): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "JARVIS Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "JARVIS Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
    });
}

/** A local origin with one commit on `main`. */
function makeOrigin(): { url: string; dir: string } {
    const base = tempDir("jarvis-origin-");
    const dir = path.join(base, "origin");
    mkdirSync(dir);
    git(["init", "-q", "-b", "main"], dir);
    writeFileSync(path.join(dir, "README.md"), "hello\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "init"], dir);
    return { url: `file://${dir}`, dir };
}

describe("repository references", () => {
    it("parses owner/name into a canonical GitHub URL", () => {
        expect(parseRepoEntry("luke/app")).toEqual({
            entry: "luke/app",
            owner: "luke",
            name: "app",
            url: "https://github.com/luke/app",
        });
    });

    it("treats a URL with .git the same as one without", () => {
        expect(parseRepoEntry("https://github.com/luke/app.git")?.url).toBe(
            "https://github.com/luke/app",
        );
    });

    it("refuses anything that is not a repository", () => {
        expect(parseRepoEntry("../etc/passwd")).toBeNull();
        expect(parseRepoEntry("luke/app/extra")).toBeNull();
        expect(parseRepoEntry("https://host/..")).toBeNull();
        expect(parseRepoEntry("   ")).toBeNull();
    });

    it("allows only the allowlisted repository", () => {
        const manager = createWorkspaceManager({
            root: tempDir("jarvis-jobs-"),
            repos: ["luke/app"],
        });

        expect(manager.allows("luke/app")?.name).toBe("app");
        expect(manager.allows("luke/other")).toBeNull();
        expect(manager.allows("https://github.com/luke/app")).not.toBeNull();
    });
});

describe("workspace lifecycle", () => {
    it("clones, branches, collects and removes", async () => {
        const origin = makeOrigin();
        const root = tempDir("jarvis-jobs-");
        const manager = createWorkspaceManager({
            root,
            hostRoot: "/host/jobs",
            repos: [origin.url],
        });
        const repo = manager.allows(origin.url);
        if (repo === null) {
            throw new Error("fixture repo not allowed");
        }

        const prepared = await manager.prepare({
            jobId: "job-1",
            repo,
            branch: "jarvis/fix-it-12345678",
        });

        expect(prepared.path).toBe(path.join(root, "job-1", "repo"));
        expect(prepared.hostPath).toBe("/host/jobs/job-1/repo");
        expect(
            readFileSync(path.join(prepared.path, "README.md"), "utf8"),
        ).toBe("hello\n");
        // The branch is the one the agent will work on, not the origin's.
        expect(
            git(["rev-parse", "--abbrev-ref", "HEAD"], prepared.path).trim(),
        ).toBe("jarvis/fix-it-12345678");

        // A clean clone has nothing to report.
        expect(await manager.collect({ workspacePath: prepared.path })).toEqual(
            {
                changed: false,
                diffSummary: "",
            },
        );

        writeFileSync(path.join(prepared.path, "README.md"), "hello\nworld\n");
        const collected = await manager.collect({
            workspacePath: prepared.path,
        });
        expect(collected.changed).toBe(true);
        expect(collected.diffSummary).toContain("README.md");

        // A committed change is reported by the commits it added, not by the
        // origin's history.
        git(["add", "."], prepared.path);
        git(["commit", "-q", "-m", "fix the thing"], prepared.path);
        // A committed change is still a change: the branch differs from the
        // clone even though the working tree is clean.
        const committed = await manager.collect({
            workspacePath: prepared.path,
        });
        expect(committed.changed).toBe(true);
        expect(committed.diffSummary).toContain("new commits:");
        expect(committed.diffSummary).toContain("fix the thing");

        await manager.remove(prepared.path);
        expect(existsSync(path.join(root, "job-1"))).toBe(false);
    });

    it("refuses a job id that is not a path segment", async () => {
        const origin = makeOrigin();
        const manager = createWorkspaceManager({
            root: tempDir("jarvis-jobs-"),
            repos: [origin.url],
        });
        const repo = manager.allows(origin.url);
        if (repo === null) {
            throw new Error("fixture repo not allowed");
        }

        await expect(
            manager.prepare({ jobId: "../escape", repo, branch: "b" }),
        ).rejects.toThrow(/path segment/);
    });

    it("commits an uncommitted change and leaves a clean tree", async () => {
        const origin = makeOrigin();
        const manager = createWorkspaceManager({
            root: tempDir("jarvis-jobs-"),
            repos: [origin.url],
        });
        const repo = manager.allows(origin.url);
        if (repo === null) {
            throw new Error("fixture repo not allowed");
        }
        const prepared = await manager.prepare({
            jobId: "job-commit",
            repo,
            branch: "jarvis/test",
        });
        writeFileSync(path.join(prepared.path, "README.md"), "changed\n");

        expect(
            await manager.commit({
                workspacePath: prepared.path,
                message: "JARVIS: change it",
            }),
        ).toBe(true);
        expect(git(["log", "--oneline", "-1"], prepared.path).trim()).toContain(
            "JARVIS: change it",
        );
        // The safety-net commit carries its own identity: a CI host has no
        // global git user, and an inherited one would misattribute the work.
        expect(
            git(["log", "-1", "--format=%an <%ae>"], prepared.path).trim(),
        ).toBe("JARVIS <jarvis@localhost>");
        // A second commit with nothing to add is a no-op, not an empty commit.
        expect(
            await manager.commit({
                workspacePath: prepared.path,
                message: "JARVIS: again",
            }),
        ).toBe(false);
    });

    it("does not run a hook, filter or signing program the agent planted", async () => {
        const origin = makeOrigin();
        const manager = createWorkspaceManager({
            root: tempDir("jarvis-jobs-"),
            repos: [origin.url],
        });
        const repo = manager.allows(origin.url);
        if (repo === null) {
            throw new Error("fixture repo not allowed");
        }
        const prepared = await manager.prepare({
            jobId: "job-hostile",
            repo,
            branch: "jarvis/test",
        });

        // Everything below executes on the *host* if git is allowed to read
        // it: a pre-commit hook, a clean filter, and a signing program.
        const marker = path.join(prepared.path, "pwned");
        const hooks = path.join(prepared.path, "evil-hooks");
        mkdirSync(hooks);
        writeFileSync(
            path.join(hooks, "pre-commit"),
            `#!/bin/sh\ntouch '${marker}'\n`,
            { mode: 0o755 },
        );
        const evil = path.join(prepared.path, "evil.sh");
        writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\ncat\n`, {
            mode: 0o755,
        });
        const configPath = path.join(prepared.path, ".git", "config");
        writeFileSync(
            configPath,
            `${readFileSync(configPath, "utf8")}[core]\n\thooksPath = ${hooks}\n[filter "evil"]\n\tclean = ${evil}\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${evil}\n`,
        );
        writeFileSync(
            path.join(prepared.path, ".gitattributes"),
            "* filter=evil\n",
        );
        writeFileSync(path.join(prepared.path, "README.md"), "changed\n");

        // Whether the add succeeds or refuses the now-undefined filter, the
        // point is that nothing ran.
        await manager
            .commit({
                workspacePath: prepared.path,
                message: "JARVIS: change it",
            })
            .catch(() => false);

        expect(existsSync(marker)).toBe(false);
        const rewritten = readFileSync(configPath, "utf8");
        expect(rewritten).not.toContain("hooksPath");
        expect(rewritten).not.toContain("clean =");
        expect(rewritten).not.toContain("gpgsign");
    });

    it("ignores an external diff driver while collecting", async () => {
        const origin = makeOrigin();
        const manager = createWorkspaceManager({
            root: tempDir("jarvis-jobs-"),
            repos: [origin.url],
        });
        const repo = manager.allows(origin.url);
        if (repo === null) {
            throw new Error("fixture repo not allowed");
        }
        const prepared = await manager.prepare({
            jobId: "job-diff",
            repo,
            branch: "jarvis/test",
        });
        writeFileSync(path.join(prepared.path, "README.md"), "changed\n");

        const marker = path.join(prepared.path, "diff-ran");
        const evil = path.join(prepared.path, "external-diff.sh");
        writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, {
            mode: 0o755,
        });
        const configPath = path.join(prepared.path, ".git", "config");
        writeFileSync(
            configPath,
            `${readFileSync(configPath, "utf8")}[diff]\n\texternal = ${evil}\n`,
        );

        const collected = await manager.collect({
            workspacePath: prepared.path,
        });

        expect(collected.changed).toBe(true);
        expect(existsSync(marker)).toBe(false);
    });

    it("refuses a .git that is a gitfile rather than a directory", async () => {
        const origin = makeOrigin();
        const manager = createWorkspaceManager({
            root: tempDir("jarvis-jobs-"),
            repos: [origin.url],
        });
        const repo = manager.allows(origin.url);
        if (repo === null) {
            throw new Error("fixture repo not allowed");
        }
        const prepared = await manager.prepare({
            jobId: "job-gitfile",
            repo,
            branch: "jarvis/test",
        });
        rmSync(path.join(prepared.path, ".git"), {
            recursive: true,
            force: true,
        });
        writeFileSync(
            path.join(prepared.path, ".git"),
            `gitdir: ${prepared.path}/elsewhere\n`,
        );

        await expect(
            manager.commit({
                workspacePath: prepared.path,
                message: "JARVIS: change it",
            }),
        ).rejects.toThrow(/not a real directory/);
        await expect(
            manager.collect({ workspacePath: prepared.path }),
        ).rejects.toThrow(/not a real directory/);
    });

    it("never deletes outside its root", async () => {
        const root = tempDir("jarvis-jobs-");
        const outside = tempDir("jarvis-outside-");
        const kept = path.join(outside, "keep.txt");
        writeFileSync(kept, "keep me\n");
        const manager = createWorkspaceManager({ root, repos: [] });

        await manager.remove(kept);

        expect(existsSync(kept)).toBe(true);
    });

    it("sweeps directories whose job is gone and keeps live ones", async () => {
        const root = tempDir("jarvis-jobs-");
        mkdirSync(path.join(root, "live", "repo"), { recursive: true });
        mkdirSync(path.join(root, "orphan", "repo"), { recursive: true });

        const swept = await sweepWorkspaces(root, (jobId) => jobId === "live");

        expect(swept).toEqual(["orphan"]);
        expect(existsSync(path.join(root, "live"))).toBe(true);
        expect(existsSync(path.join(root, "orphan"))).toBe(false);
    });
});
