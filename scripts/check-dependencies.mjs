/**
 * Fails when a workspace package imports a module it never declared.
 *
 * A phantom dependency is invisible to every existing gate: `tsc` accepts the
 * import because `@types/*` is usually present, and tests pass because npm
 * workspaces hoist a sibling package's copy into the root `node_modules`.
 * Resolution then depends on an unrelated package's manifest, which breaks the
 * moment a package is consumed on its own or a hoisted sibling drops the
 * transitive. This check makes that class of error fail locally instead.
 *
 * Sources are parsed with esbuild and re-emitted as CommonJS, then the emitted
 * `require("…")` calls are collected. Going through the compiler means comments,
 * JSDoc code samples, type-only imports, and inline `type` specifiers are
 * discarded by the transform rather than matched by a fragile regular
 * expression — the failure mode that matters most here, since a check that
 * false-positives on documentation is a check people disable.
 *
 * Rules:
 * - A test file is any file under `src/` or `test/` named `*.test.*`,
 *   `*.spec.*`, or living in a `__tests__` directory. Test files may satisfy
 *   imports from `devDependencies`; the `portal` and `web` packages colocate
 *   their suites inside `src/`, so directory alone does not identify them.
 * - Other `src/` imports must be declared in `dependencies`,
 *   `peerDependencies`, or `optionalDependencies`. A `devDependencies`-only
 *   import from shipped code is reported, because it will not exist for
 *   consumers.
 * - `test/` imports follow the same rule as shipped code.
 * - Node builtins are ignored, both `node:`-prefixed and bare.
 * - Relative and absolute specifiers are ignored; a scoped specifier is reduced
 *   to `@scope/name`, so subpaths (`…/jarvis-auth/testing`) resolve to their
 *   owning package.
 * - Dynamic `import()` with a non-literal argument is not statically analysable
 *   and is skipped.
 *
 * Run from the repo root: `npm run check:deps`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace package directories, in the order they are reported. */
const PACKAGES_DIR = join(REPO_ROOT, "packages");

/** Repo-root tooling, checked against the root manifest. */
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");

/** Directories holding each package's shipped code, keyed to its source dir. */
const SHIPPED_DIR = "src";

/** Dependency fields that satisfy a runtime import from shipped code. */
const RUNTIME_FIELDS = [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
];

/** Extra dependency fields accepted for test-only imports. */
const TEST_ONLY_FIELDS = ["devDependencies"];

const BUILTINS = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
]);

/** Extensions worth parsing, mapped to the esbuild loader that reads them. */
const LOADERS = {
    ".ts": "ts",
    ".tsx": "tsx",
    ".mts": "ts",
    ".cts": "ts",
    ".js": "js",
    ".jsx": "jsx",
    ".mjs": "js",
    ".cjs": "js",
};

/** One reported undeclared import. */
class Violation {
    constructor(file, specifier, line, kind, reason) {
        this.file = file;
        this.specifier = specifier;
        this.line = line;
        this.kind = kind;
        this.reason = reason;
    }
}

/**
 * Reduces an import specifier to the package that must declare it.
 *
 * Scoped specifiers keep their first two segments (`@scope/name`) so subpath
 * imports attribute to their owning package; everything else keeps its first
 * segment. Returns null for relative and absolute specifiers, which no manifest
 * can declare.
 */
function packageNameOf(specifier) {
    if (
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        specifier.includes(":")
    ) {
        return null;
    }
    const segments = specifier.split("/");
    return specifier.startsWith("@")
        ? segments.slice(0, 2).join("/")
        : segments[0];
}

/** True when the specifier names a Node builtin in either spelling. */
function isBuiltin(specifier) {
    return (
        specifier.startsWith("node:") ||
        BUILTINS.has(specifier) ||
        BUILTINS.has(packageNameOf(specifier) ?? "")
    );
}

/**
 * Parses one file and returns its static runtime module specifiers with lines.
 *
 * The source is transformed to CommonJS with tree-shaking off, so every import
 * the file actually keeps becomes a `require("…")` call on a predictable line.
 * Type-only imports and anything inside comments are erased by the transform.
 * Returns an empty list for files esbuild cannot parse, leaving diagnostics to
 * the type checker rather than guessing.
 */
function readSpecifiers(absolutePath) {
    const loader = LOADERS[absolutePath.slice(-4).replace(/.*(\.\w+)$/, "$1")];
    if (!loader) {
        return [];
    }
    let code;
    try {
        code = transformSync(readFileSync(absolutePath, "utf8"), {
            loader,
            format: "cjs",
            target: "node24",
            treeShaking: false,
        }).code;
    } catch {
        return [];
    }
    const found = [];
    const lines = code.split("\n");
    lines.forEach((text, index) => {
        for (const match of text.matchAll(/require\("([^"]+)"\)/g)) {
            found.push({ specifier: match[1], line: index + 1 });
        }
    });
    return found;
}

/** Recursively lists parseable source files under a directory. */
function listSourceFiles(dir) {
    const found = [];
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...listSourceFiles(full));
        } else if (LOADERS[full.slice(full.lastIndexOf("."))]) {
            found.push(full);
        }
    }
    return found;
}

/** Reads a workspace package manifest, or null when it is absent or malformed. */
function readManifest(packageDir) {
    try {
        return JSON.parse(
            readFileSync(join(packageDir, "package.json"), "utf8"),
        );
    } catch {
        return null;
    }
}

/**
 * Checks one package's shipped and test sources for undeclared imports.
 *
 * @param {string} packageDir Absolute path to the package directory.
 * @returns {Violation[]} Every undeclared runtime import found, annotated with
 * the dependency fields that would satisfy it.
 */
export function checkPackage(packageDir) {
    const manifest = readManifest(packageDir);
    if (!manifest) {
        return [];
    }
    const declared = new Set();
    for (const field of [...RUNTIME_FIELDS, ...TEST_ONLY_FIELDS]) {
        for (const name of Object.keys(manifest[field] ?? {})) {
            declared.add(`${field}:${name}`);
        }
    }
    const violations = [];
    const roots = [
        { dir: join(packageDir, SHIPPED_DIR) },
        { dir: join(packageDir, "test") },
    ];
    for (const { dir } of roots) {
        if (!existsDir(dir)) {
            continue;
        }
        for (const file of listSourceFiles(dir)) {
            const isTest = isTestFile(file);
            for (const { specifier, line } of readSpecifiers(file)) {
                if (isBuiltin(specifier)) {
                    continue;
                }
                const name = packageNameOf(specifier);
                if (!name || isDeclared(declared, name, isTest)) {
                    continue;
                }
                const allowed = (
                    isTest
                        ? RUNTIME_FIELDS.concat(TEST_ONLY_FIELDS)
                        : RUNTIME_FIELDS
                ).join("/");
                violations.push(
                    new Violation(
                        relative(REPO_ROOT, file),
                        specifier,
                        line,
                        isTest ? "test" : "src",
                        `${manifest.name} does not declare "${name}" in ${allowed}`,
                    ),
                );
            }
        }
    }
    return violations;
}

/**
 * True when a file is a test, by naming convention or by living in a
 * `__tests__` directory.
 *
 * The Vite packages colocate their suites inside `src/` (`src/api.test.ts`), so
 * the containing directory alone does not identify a test.
 */
function isTestFile(file) {
    const base = file.slice(file.lastIndexOf("/") + 1);
    return (
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
        file.split("/").includes("__tests__")
    );
}

/**
 * True when a package declares a dependency name in an acceptable field.
 *
 * Test files additionally accept `devDependencies`; shipped code does not,
 * because a dev-only dependency is absent for consumers.
 */
function isDeclared(declared, name, isTest) {
    const fields = isTest
        ? RUNTIME_FIELDS.concat(TEST_ONLY_FIELDS)
        : RUNTIME_FIELDS;
    return fields.some((field) => declared.has(`${field}:${name}`));
}

/** True when a path exists and is a directory. */
function existsDir(path) {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Checks every workspace package under `packages/`.
 *
 * @param {string} [packagesDir] Directory holding the workspace packages.
 * @returns {Violation[]} Undeclared imports across all packages.
 */
export function checkAll(packagesDir = PACKAGES_DIR) {
    const violations = [];
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        violations.push(...checkPackage(join(packagesDir, entry.name)));
    }
    violations.push(...checkSelf());
    return violations;
}

/**
 * Checks the guard's own imports against the root manifest.
 *
 * A dependency guard with an undeclared dependency would be an embarrassing
 * failure mode, so it holds itself to the rule it enforces. `scripts/` is
 * repo tooling that is never published, so `devDependencies` satisfies it.
 *
 * @returns {Violation[]} Undeclared imports in `scripts/`.
 */
export function checkSelf() {
    const manifest = readManifest(REPO_ROOT);
    if (!manifest) {
        return [];
    }
    const declared = new Set();
    for (const field of [...RUNTIME_FIELDS, ...TEST_ONLY_FIELDS]) {
        for (const name of Object.keys(manifest[field] ?? {})) {
            declared.add(`${field}:${name}`);
        }
    }
    const violations = [];
    for (const file of listSourceFiles(SCRIPTS_DIR)) {
        for (const { specifier, line } of readSpecifiers(file)) {
            if (isBuiltin(specifier)) {
                continue;
            }
            const name = packageNameOf(specifier);
            if (!name || isDeclared(declared, name, true)) {
                continue;
            }
            violations.push(
                new Violation(
                    relative(REPO_ROOT, file),
                    specifier,
                    line,
                    "scripts",
                    `root does not declare "${name}" in ${RUNTIME_FIELDS.concat(
                        TEST_ONLY_FIELDS,
                    ).join("/")}`,
                ),
            );
        }
    }
    return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const violations = checkAll();
    if (violations.length === 0) {
        console.log("check:deps — no undeclared imports");
    } else {
        console.error(
            `check:deps — ${violations.length} undeclared import(s):\n`,
        );
        for (const v of violations) {
            console.error(`  ${v.file}:${v.line}`);
            console.error(`    ${v.specifier}`);
            console.error(`    ${v.reason}\n`);
        }
        console.error(
            "Declare the dependency in the package's package.json, or use a " +
                "relative path if it is local code.",
        );
        process.exitCode = 1;
    }
}
