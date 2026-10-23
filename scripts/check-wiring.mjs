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
 * renders it. The base is `JARVIS_WIRING_BASE` when set (the job can name the
 * PR's base), otherwise `origin/main`.
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

const base = process.env.JARVIS_WIRING_BASE ?? "origin/main";
let mergeBase;
try {
    mergeBase = execFileSync("git", ["merge-base", base, "HEAD"], {
        encoding: "utf8",
    }).trim();
} catch {
    console.error(`check:wiring — cannot resolve the base \`${base}\``);
    process.exit(1);
}

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
const added = [...new Set([...addedTracked, ...untracked])].filter(
    (file) => isSource(file) && !isBarrel(file),
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
