#!/usr/bin/env node
/**
 * Checks that every source file added on this branch has a direct importer.
 *
 * The first two PRs failed the same way: a component was added, exported from a
 * barrel, and never imported by a surface. `npm run check` stayed green because
 * an orphaned module is not an unused import. This check closes that gap for
 * every package's `src`, not only the web: a new source file must be imported by
 * a non-test, non-barrel source on the same branch.
 *
 * A barrel `index.ts` re-export is deliberately not an importer. Neither is a
 * test: a unit test of the component proves the component, not that a page
 * renders it.
 *
 * The base is `JARVIS_WIRING_BASE` when set (the job can name the PR's base),
 * otherwise the first base ref that resolves (`origin/<GITHUB_BASE_REF>`,
 * `origin/main`, `main`). GitHub Actions checks out `refs/pull/N/merge` — a
 * synthetic merge commit whose first parent is the base tip — and that checkout
 * has no `origin/main`, so the merge commit's first parent is the last resort.
 *
 * Usage:
 *
 *     node scripts/check-wiring.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
}).trim();
process.chdir(root);

/**
 * The refs to try, most specific first.
 *
 * `GITHUB_BASE_REF` is set on a pull-request run; naming it before
 * `origin/main` means a fork or a non-`main` base is compared against the right
 * branch rather than a lucky default.
 *
 * @returns The candidate refs, in order.
 */
function baseCandidates() {
    const candidates = [];
    if (process.env.JARVIS_WIRING_BASE) {
        candidates.push(process.env.JARVIS_WIRING_BASE);
    }
    if (process.env.GITHUB_BASE_REF) {
        candidates.push(
            `origin/${process.env.GITHUB_BASE_REF}`,
            process.env.GITHUB_BASE_REF,
        );
    }
    candidates.push("origin/main", "main");
    return [...new Set(candidates)];
}

/**
 * Resolves the commit this branch's changes are measured from.
 *
 * A plain local checkout has `origin/main` (or `main`). The Actions checkout of
 * a pull request does not: it is a synthetic merge commit, so the base tip is
 * its first parent. If neither shape is available the check fails rather than
 * guessing — comparing against the wrong base would either miss the added files
 * or flag the whole repository.
 *
 * @returns The merge-base commit.
 */
function resolveMergeBase() {
    const tried = [];
    for (const base of baseCandidates()) {
        tried.push(base);
        try {
            return execFileSync("git", ["merge-base", base, "HEAD"], {
                encoding: "utf8",
                // A candidate that does not exist is the normal path in the
                // Actions checkout; its `fatal:` belongs in the "tried" line,
                // not in every log.
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
        } catch {
            // Try the next candidate.
        }
    }
    const parents = execFileSync(
        "git",
        ["rev-list", "--parents", "-n", "1", "HEAD"],
        { encoding: "utf8" },
    )
        .trim()
        .split(" ")
        .filter(Boolean);
    if (parents.length >= 3) {
        tried.push("HEAD^1 (pull-request merge commit)");
        return execFileSync("git", ["merge-base", "HEAD^1", "HEAD"], {
            encoding: "utf8",
        }).trim();
    }
    console.error(
        `check:wiring — cannot resolve a base (tried ${tried.join(", ")})`,
    );
    process.exit(1);
}

const mergeBase = resolveMergeBase();

/** One source file under a package's `src`. */
function isSource(file) {
    return (
        /^packages\/[^/]+\/src\/.+\.(ts|tsx)$/.test(file) &&
        !/\.(test|spec)\.(ts|tsx)$/.test(file) &&
        !/\/vite-env\.d\.ts$/.test(file)
    );
}

/**
 * A barrel is an `index.ts` that only re-exports. A package entrypoint like
 * `packages/server/src/index.ts` also has imports (it is the composition root),
 * so it is a real importer and must not be excluded.
 */
function isBarrel(file) {
    if (!/\/index\.ts$/.test(file)) {
        return false;
    }
    try {
        const content = readFileSync(file, "utf8");
        return !/\bimport\s/.test(content) && /^\s*export\s/m.test(content);
    } catch {
        return false;
    }
}

const addedTracked = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=A", `${mergeBase}...HEAD`],
    { encoding: "utf8" },
)
    .split("\n")
    .filter(Boolean);
const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { encoding: "utf8" },
)
    .split("\n")
    .filter(Boolean);
/**
 * A package's `src/index.ts` is the surface itself, not a component that needs
 * an importer. This matters when a PR adds a whole new package: its entrypoint
 * is necessarily the root of the import graph.
 */
function isPackageEntrypoint(file) {
    return /^packages\/[^/]+\/src\/index\.ts$/.test(file);
}

const added = [...new Set([...addedTracked, ...untracked])].filter(
    (file) => isSource(file) && !isBarrel(file) && !isPackageEntrypoint(file),
);

// Importers may themselves be new and untracked: a brand-new surface can wire
// a brand-new component. Build the universe from tracked *and* untracked src.
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
const sources = [
    ...new Set([...tracked, ...untracked].filter((file) => isSource(file))),
].filter((file) => !isBarrel(file));

const text = new Map(sources.map((file) => [file, readFileSync(file, "utf8")]));

const problems = [];
for (const file of added) {
    const stem = path.basename(file).replace(/\.(ts|tsx)$/, "");
    // `from "./RowActions"` or `from "../Row/RowActions"`; a barrel re-export
    // and a test importer are excluded by `sources`.
    const importPattern = new RegExp(`from\\s+["'][^"']*(?:/|^)${stem}["']`);
    const importer = sources.find(
        (candidate) =>
            candidate !== file && importPattern.test(text.get(candidate) ?? ""),
    );
    if (importer === undefined) {
        problems.push(file);
    }
}

if (problems.length > 0) {
    console.error(
        "check:wiring — these added source files have no direct importer:",
    );
    for (const file of problems) {
        console.error(`  ${file}`);
    }
    console.error(
        "A barrel re-export or a test import does not count. Import each new component from the non-test surface that renders it.",
    );
    process.exit(1);
}

console.log(
    `check:wiring — every added source file has a direct importer (${added.length} checked)`,
);
