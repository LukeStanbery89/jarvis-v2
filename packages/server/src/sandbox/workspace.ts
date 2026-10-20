/**
 * The worker's workspace (#141): clone, branch, collect, remove.
 *
 * A coding job does not edit anything JARVIS runs from. Each job gets its own
 * clone under `~/.jarvis/jobs/<jobId>/repo`, created on its own branch before
 * the container starts; that directory is the *only* host path the container
 * sees, and it is what makes a crash disposable — re-running a job simply
 * clones again.
 *
 * The same tree has two names. The server reads and writes it directly; the
 * Docker daemon resolves a bind source on the **host**, so a server running in
 * a container must pass the host's path, not its own. {@link PreparedWorkspace}
 * carries both, and mixing them up silently mounts an empty directory — the
 * trap the sandbox probe reproduces.
 *
 * Git runs on the host, deliberately: cloning inside the sandbox would put a
 * credential in the container, and the host is where the finished branch is
 * pushed from. The repository is therefore an *allowlisted* one (config), and
 * the clone cannot prompt for credentials (`GIT_TERMINAL_PROMPT=0`), so a
 * private repo fails loudly instead of hanging a job.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir } from "@lukestanbery/jarvis-auth";

const execFileAsync = promisify(execFile);

/** The largest diff summary stored on a row. */
const MAX_DIFF_SUMMARY_CHARS = 8_000;

/**
 * Global git options that keep a workspace from configuring behavior.
 *
 * After the agent has run, `.git` is hostile input to *our* git calls: a
 * `pre-commit` hook, a `core.hooksPath`, a `filter.*.clean`, a
 * `diff.external`, or `commit.gpgsign` with a `gpg.program` are all ways to
 * turn a host-side `git` invocation into arbitrary host code. The config
 * rewrite ({@link sanitizeGitConfig}) removes those definitions, and these
 * flags are the second layer for anything a config might still carry.
 */
const HARDENING_FLAGS = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    "log.showSignature=false",
] as const;

/** A repository the sandbox may clone. */
export interface RepoSpec {
    /** The allowlist entry, as written. */
    entry: string;
    /** `owner`, or the host when the entry is a bare URL. */
    owner: string;
    /** The repository name (no `.git`). */
    name: string;
    /** The URL handed to `git clone`. */
    url: string;
}

/** Runs git; injectable so a test can assert the commands without one. */
export type GitRunner = (
    args: readonly string[],
    options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

/** The server-side and daemon-side names of one prepared clone. */
export interface PreparedWorkspace {
    /** Where the server reads and writes it. */
    path: string;
    /** Where the daemon mounts it. */
    hostPath: string;
}

/** The workspace capability the supervisor depends on. */
export interface WorkspaceManager {
    /** Resolves an allowlist entry to a repository, or `null` when not allowed. */
    allows(repo: string): RepoSpec | null;
    /** Clones the repository and creates the job's branch. */
    prepare(input: {
        jobId: string;
        repo: RepoSpec;
        branch: string;
    }): Promise<PreparedWorkspace>;
    /** Describes what the run left behind. */
    collect(input: { workspacePath: string }): Promise<{
        changed: boolean;
        diffSummary: string;
    }>;
    /**
     * Commits anything the agent left uncommitted, so a finished job's branch
     * always contains the work it produced.
     *
     * A model can edit a file and then *say* it committed without calling git;
     * the first live run did exactly that. The host is the party that can make
     * the claim true.
     *
     * @returns True when it made a commit, false when the tree was clean.
     */
    commit(input: { workspacePath: string; message: string }): Promise<boolean>;
    /** Removes one job's workspace (the job directory, not just `repo`). */
    remove(workspacePath: string): Promise<void>;
}

/** Job ids are used as directory names, so only a boring id is accepted. */
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parses one repository reference.
 *
 * Two spellings are accepted, and both are compared canonically against the
 * allowlist: `owner/name` (GitHub over HTTPS) and a full `https://`/`file://`
 * URL (the latter is what the tests use, and what a self-hosted forge would
 * take).
 *
 * @param entry - A repository reference.
 * @returns The parsed spec, or `null` when it is not a repository reference.
 */
export function parseRepoEntry(entry: string): RepoSpec | null {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
        return null;
    }
    if (/^(https?|file):\/\//i.test(trimmed)) {
        let url: URL;
        try {
            url = new URL(trimmed);
        } catch {
            return null;
        }
        const segments = url.pathname
            .replace(/\/+$/, "")
            .replace(/\.git$/i, "")
            .split("/")
            .filter((segment) => segment.length > 0);
        const name = segments[segments.length - 1];
        if (name === undefined || !isBoringName(name)) {
            return null;
        }
        const owner =
            segments.length >= 2
                ? (segments[segments.length - 2] ?? url.host)
                : url.host;
        return {
            entry: trimmed,
            owner,
            name,
            // No `.git` on the canonical URL: `git clone` accepts either, and
            // one spelling keeps the allowlist comparison from depending on
            // how an entry happened to be written.
            url: url
                .toString()
                .replace(/\/+$/, "")
                .replace(/\.git$/i, ""),
        };
    }
    const parts = trimmed.split("/");
    if (parts.length !== 2) {
        return null;
    }
    const [owner, rawName] = parts;
    const name = rawName.replace(/\.git$/i, "");
    if (owner === undefined || !isBoringName(owner) || !isBoringName(name)) {
        return null;
    }
    return {
        entry: trimmed,
        owner,
        name,
        url: `https://github.com/${owner}/${name}`,
    };
}

/**
 * Whether a path segment is safe to use in a URL and a directory name.
 *
 * @param value - The segment.
 * @returns True for letters, digits and `.`, `_`, `-` (but not `..`).
 */
function isBoringName(value: string): boolean {
    return (
        value.length > 0 &&
        value !== "." &&
        value !== ".." &&
        /^[A-Za-z0-9._-]+$/.test(value)
    );
}

/**
 * The spelling two references are compared by.
 *
 * URL parsing lowercases the scheme and host, which is what makes
 * `HTTPS://GitHub.com/a/b` and `https://github.com/a/b` the same allowlist
 * entry; a `file://` path keeps its case, because the filesystem may.
 *
 * @param spec - A parsed repository.
 * @returns A comparison key.
 */
function canonicalRepo(spec: RepoSpec): string {
    try {
        return new URL(spec.url).toString();
    } catch {
        return spec.url;
    }
}

/** The git runner used in production: no prompt, no workspace-defined behavior. */
const defaultGit: GitRunner = async (args, options = {}) => {
    const { stdout, stderr } = await execFileAsync(
        "git",
        [...HARDENING_FLAGS, ...args],
        {
            cwd: options.cwd,
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
    );
    return { stdout, stderr };
};

/**
 * Rewrites a workspace's `.git/config` to the minimal shape a clone needs.
 *
 * The agent inside the container writes to the workspace, `.git` included, and
 * the host then runs git there to collect and commit. A repository can never
 * ship hooks, but an agent can *plant* them (or a `core.hooksPath`, a
 * `filter.*.clean`, a `diff.external`, a `gpg.program` with signing enabled) —
 * all of which execute on the host. Dropping every key we did not create turns
 * that back into data: only `core`, the origin URL and its fetch refspec
 * survive, and the URL is validated to one boring line so a newline cannot
 * smuggle a second section back in.
 *
 * It fails closed on a shape it cannot vouch for: a `.git` that is a gitfile or
 * symlink (host git would read a config this rewrite never saw) and a
 * `.git/config` that is a symlink or not a regular file both throw. The rewrite
 * is written beside the file and renamed into place, so it replaces a symlink
 * rather than following one.
 *
 * A workspace with no `.git` has nothing to strip, and the caller's git command
 * then fails honestly.
 *
 * @param workspacePath - The server-side path of the job's clone.
 */
export function sanitizeGitConfig(workspacePath: string): void {
    const gitDir = path.join(workspacePath, ".git");
    let gitStat;
    try {
        gitStat = lstatSync(gitDir);
    } catch {
        // No `.git` at all: there is no behavior to strip, and the caller's
        // git command will fail honestly.
        return;
    }
    // A gitfile or symlink here names a directory outside this rewrite; host
    // git would read *that* config, hooks and filters included. Refuse rather
    // than guess — a job has no legitimate reason to replace `.git`.
    if (!gitStat.isDirectory()) {
        throw new Error("the workspace's .git is not a real directory");
    }
    const configPath = path.join(gitDir, "config");
    let original = "";
    try {
        // A symlinked config could point at a host file (read or, worse,
        // overwritten by the rewrite), and a FIFO would block the read.
        if (!lstatSync(configPath).isFile()) {
            throw new Error(
                "the workspace's .git/config is not a regular file",
            );
        }
        original = readFileSync(configPath, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
        }
    }
    const url = /^\s*url\s*=\s*(.+)$/m.exec(original)?.[1]?.trim() ?? "";
    // A clone URL, or nothing. The first line only: `(.+)` cannot cross a
    // newline, so an injected `[filter]` section is not carried over.
    const origin = /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|[^\s:]+@[^\s:]+:\S+)$/i.test(
        url,
    )
        ? url
        : "";
    const lines = [
        "[core]",
        "\trepositoryformatversion = 0",
        "\tfilemode = true",
        "\tbare = false",
        "\tlogallrefupdates = true",
    ];
    if (origin.length > 0) {
        lines.push(
            '[remote "origin"]',
            `\turl = ${origin}`,
            "\tfetch = +refs/heads/*:refs/remotes/origin/*",
        );
    }
    lines.push("");
    // Write beside it and rename: a rename replaces a symlink instead of
    // following it, so this cannot be aimed at a file outside the workspace.
    const temp = path.join(
        gitDir,
        `.config.jarvis-${process.pid}-${Date.now()}`,
    );
    writeFileSync(temp, lines.join("\n"), { mode: 0o600, flag: "wx" });
    renameSync(temp, configPath);
}

/**
 * Builds the workspace manager.
 *
 * @param options - The server root, the daemon's root, the allowlist and git.
 * @returns The manager the supervisor uses.
 */
export function createWorkspaceManager(options: {
    root: string;
    hostRoot?: string;
    repos: readonly string[];
    git?: GitRunner;
}): WorkspaceManager {
    const root = path.resolve(options.root);
    const hostRoot = path.resolve(options.hostRoot ?? options.root);
    const git = options.git ?? defaultGit;
    const allowlist = options.repos
        .map((entry) => parseRepoEntry(entry))
        .filter((spec): spec is RepoSpec => spec !== null)
        .map((spec) => canonicalRepo(spec));

    return {
        allows(repo: string): RepoSpec | null {
            const spec = parseRepoEntry(repo);
            if (spec === null) {
                return null;
            }
            return allowlist.includes(canonicalRepo(spec)) ? spec : null;
        },

        async prepare(input): Promise<PreparedWorkspace> {
            if (!JOB_ID_PATTERN.test(input.jobId)) {
                throw new Error(`refusing a job id that is not a path segment`);
            }
            const jobDir = path.join(root, input.jobId);
            ensurePrivateDir(jobDir);
            const dir = path.join(jobDir, "repo");
            await git([
                "clone",
                // A job is short-lived and its submodules are nobody's
                // business here; cloning them would also run code from the
                // remote before the container exists.
                "--no-recurse-submodules",
                input.repo.url,
                dir,
            ]);
            await git(["-C", dir, "checkout", "-b", input.branch]);
            return {
                path: dir,
                hostPath: path.join(hostRoot, input.jobId, "repo"),
            };
        },

        async collect(input): Promise<{
            changed: boolean;
            diffSummary: string;
        }> {
            // The tree the agent left is untrusted; strip executable behavior
            // before any host git reads it (#141 phase 7).
            sanitizeGitConfig(input.workspacePath);
            const { stdout: status } = await git([
                "-C",
                input.workspacePath,
                "status",
                "--porcelain",
            ]);
            const { stdout: diff } = await git([
                "-C",
                input.workspacePath,
                "diff",
                "--stat",
                // Neither flag is implied by the config rewrite: a driver
                // can still be named by `.gitattributes` even with no
                // definition, and an external diff is a config key.
                "--no-ext-diff",
                "--no-textconv",
            ]);
            // Only the commits the run *added*: `origin/HEAD` is where the
            // clone started, so a clean clone reports nothing instead of
            // echoing the project's history back as an artifact.
            const { stdout: log } = await git([
                "-C",
                input.workspacePath,
                "log",
                "--oneline",
                "origin/HEAD..HEAD",
            ]).catch(() => ({ stdout: "", stderr: "" }));
            const sections: string[] = [];
            if (status.trim().length > 0) {
                sections.push(`changed files:\n${status.trim()}`);
            }
            if (diff.trim().length > 0) {
                sections.push(`diff:\n${diff.trim()}`);
            }
            if (log.trim().length > 0) {
                sections.push(`new commits:\n${log.trim()}`);
            }
            return {
                // "Changed" means the branch differs from the clone — a dirty
                // tree *or* new commits. Checking only `status` mislabeled a
                // job that committed its work as "no changes" (the live run
                // that produced `51b41f5`).
                changed: status.trim().length > 0 || log.trim().length > 0,
                diffSummary: sections
                    .join("\n\n")
                    .slice(0, MAX_DIFF_SUMMARY_CHARS),
            };
        },

        async commit(input): Promise<boolean> {
            // Same reason as `collect`: a hook, filter or signing program in
            // this workspace would run on the host.
            sanitizeGitConfig(input.workspacePath);
            const { stdout: status } = await git([
                "-C",
                input.workspacePath,
                "status",
                "--porcelain",
            ]);
            if (status.trim().length === 0) {
                return false;
            }
            await git(["-C", input.workspacePath, "add", "-A"]);
            // The safety-net commit must not depend on a host git identity:
            // CI has none, and an inherited identity would misattribute the
            // agent's work. Name the committer explicitly. (Hardening these
            // host-side git calls against a hostile workspace is tracked on
            // #141.)
            await git([
                "-C",
                input.workspacePath,
                "-c",
                "user.name=JARVIS",
                "-c",
                "user.email=jarvis@localhost",
                "commit",
                "-m",
                input.message,
            ]);
            return true;
        },

        async remove(workspacePath: string): Promise<void> {
            const resolved = path.resolve(workspacePath);
            const jobDir = path.dirname(resolved);
            // Only ever delete inside the root this manager owns: a corrupt
            // row must not be able to name `/`.
            const insideRoot =
                path.dirname(jobDir) === root &&
                JOB_ID_PATTERN.test(path.basename(jobDir));
            const target = insideRoot ? jobDir : resolved;
            if (target !== root && target.startsWith(`${root}${path.sep}`)) {
                await rm(target, { recursive: true, force: true });
            }
        },
    };
}

/**
 * Removes workspace directories the caller no longer wants.
 *
 * The predicate is the policy: a directory with no row, or a settled job past
 * its retention, is removed; a queued or running job is kept. Boot hygiene for
 * the window the row-based paths cannot cover — a process that died after
 * creating a directory but before writing its row. Best-effort by design: a
 * directory that cannot be read is left alone.
 *
 * @param root - The server-side workspace root.
 * @param keep - Whether a job id still owns its directory.
 * @returns The ids that were removed.
 */
export async function sweepWorkspaces(
    root: string,
    keep: (jobId: string) => boolean,
): Promise<string[]> {
    let entries: string[];
    try {
        entries = await readdir(root);
    } catch {
        return [];
    }
    const removed: string[] = [];
    for (const entry of entries) {
        if (!JOB_ID_PATTERN.test(entry) || keep(entry)) {
            continue;
        }
        try {
            await rm(path.join(root, entry), { recursive: true, force: true });
            removed.push(entry);
        } catch {
            // A permission error here is not worth failing a boot over; the
            // next attempt will try again.
        }
    }
    return removed;
}
