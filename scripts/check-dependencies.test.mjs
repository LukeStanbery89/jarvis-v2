/**
 * Fixture packages for `check-dependencies.mjs`.
 *
 * Each directory under `scripts/__fixtures__/` is a synthetic package whose
 * `package.json` and sources exercise one rule of the guard. The test asserts
 * the guard reports exactly the violations each fixture is named for, so a
 * regression in the rules (or a new false positive) fails the suite instead of
 * quietly reaching `main`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAll, checkPackage, checkSelf } from "./check-dependencies.mjs";

/** Temp package trees created per test, removed afterwards. */
const created = [];

afterEach(() => {
    while (created.length > 0) {
        rmSync(created.pop(), { recursive: true, force: true });
    }
});

/**
 * Writes a throwaway package and returns its directory.
 *
 * @param {Record<string, unknown>} manifest Package manifest contents.
 * @param {Record<string, string>} files Source files keyed by relative path.
 * @returns {string} Absolute path to the package directory.
 */
function makePackage(manifest, files) {
    const dir = mkdtempSync(join(tmpdir(), "check-deps-"));
    created.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    for (const [path, contents] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, contents);
    }
    return dir;
}

/** Convenience manifest with the given dependency buckets. */
function manifest(name, buckets) {
    return { name, version: "1.0.0", ...buckets };
}

describe("checkPackage", () => {
    it("reports a shipped import with no matching dependency field", () => {
        const dir = makePackage(
            manifest("@acme/pkg", { dependencies: { declared: "^1.0.0" } }),
            { "src/index.ts": 'import x from "phantom";\nexport default x;\n' },
        );

        const violations = checkPackage(dir);

        expect(violations).toHaveLength(1);
        expect(violations[0].specifier).toBe("phantom");
        expect(violations[0].file).toContain("src/index.ts");
        expect(violations[0].kind).toBe("src");
    });

    it("accepts a shipped import declared in dependencies", () => {
        const dir = makePackage(
            manifest("@acme/pkg", { dependencies: { real: "^1.0.0" } }),
            { "src/index.ts": 'import x from "real";\nexport default x;\n' },
        );

        expect(checkPackage(dir)).toEqual([]);
    });

    it("rejects a shipped import satisfied only by devDependencies", () => {
        const dir = makePackage(
            manifest("@acme/pkg", { devDependencies: { toolish: "^1.0.0" } }),
            { "src/index.ts": 'import x from "toolish";\nexport default x;\n' },
        );

        const violations = checkPackage(dir);

        expect(violations).toHaveLength(1);
        expect(violations[0].reason).toContain("toolish");
    });

    it("accepts a devDependency-only import from a test file", () => {
        const dir = makePackage(
            manifest("@acme/pkg", { devDependencies: { helper: "^1.0.0" } }),
            {
                "src/index.ts": "export const a = 1;\n",
                "test/index.test.ts": 'import { helper } from "helper";\n',
            },
        );

        expect(checkPackage(dir)).toEqual([]);
    });

    it("treats a colocated src test as a test", () => {
        const dir = makePackage(
            manifest("@acme/pkg", { devDependencies: { helper: "^1.0.0" } }),
            { "src/api.test.ts": 'import { helper } from "helper";\n' },
        );

        expect(checkPackage(dir)).toEqual([]);
    });

    it("ignores type-only imports", () => {
        const dir = makePackage(manifest("@acme/pkg", { dependencies: {} }), {
            "src/index.ts":
                'import type { T } from "phantom";\nexport type { T };\n',
            "src/other.ts":
                'import { type Only } from "phantom2";\nexport const b = 1;\n',
        });

        expect(checkPackage(dir)).toEqual([]);
    });

    it("ignores specifiers inside comments and JSDoc samples", () => {
        const dir = makePackage(manifest("@acme/pkg", { dependencies: {} }), {
            "src/index.ts": [
                "/**",
                ' * Example: import { x } from "phantom";',
                " */",
                '// import { y } from "phantom2";',
                "export const a = 1;",
                "",
            ].join("\n"),
        });

        expect(checkPackage(dir)).toEqual([]);
    });

    it("ignores relative specifiers", () => {
        const dir = makePackage(manifest("@acme/pkg", { dependencies: {} }), {
            "src/index.ts": 'import x from "./x";\nexport default x;\n',
            "src/x.ts": 'import y from "../y";\nexport default y;\n',
        });

        expect(checkPackage(dir)).toEqual([]);
    });

    it("ignores node builtins in both spellings", () => {
        const dir = makePackage(manifest("@acme/pkg", { dependencies: {} }), {
            "src/index.ts": [
                'import { readFileSync } from "node:fs";',
                'import { createServer } from "http";',
                "export const a = readFileSync;",
                "export const b = createServer;",
                "",
            ].join("\n"),
        });

        expect(checkPackage(dir)).toEqual([]);
    });

    it("resolves a scoped subpath to its owning package", () => {
        const dir = makePackage(
            manifest("@acme/pkg", { dependencies: { "@acme/dep": "^1.0.0" } }),
            {
                "src/index.ts":
                    'import { x } from "@acme/dep/subpath";\nexport default x;\n',
            },
        );

        expect(checkPackage(dir)).toEqual([]);
    });

    it("reports an undeclared scoped subpath against its owning package", () => {
        const dir = makePackage(manifest("@acme/pkg", { dependencies: {} }), {
            "src/index.ts":
                'import { x } from "@acme/missing/subpath";\nexport default x;\n',
        });

        const violations = checkPackage(dir);

        expect(violations).toHaveLength(1);
        expect(violations[0].specifier).toBe("@acme/missing/subpath");
        expect(violations[0].reason).toContain("@acme/missing");
    });

    it("finds side-effect imports", () => {
        const dir = makePackage(manifest("@acme/pkg", { dependencies: {} }), {
            "src/index.ts": [
                'import "side-effect";',
                "export const a = 1;",
                "",
            ].join("\n"),
        });

        expect(checkPackage(dir)).toHaveLength(1);
    });

    it("ignores a directory with no manifest", () => {
        const dir = mkdtempSync(join(tmpdir(), "check-deps-empty-"));
        created.push(dir);
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "index.ts"), 'import "x";\n');

        expect(checkPackage(dir)).toEqual([]);
    });
});

describe("checkSelf", () => {
    it("finds no undeclared import in this repo's own tooling", () => {
        expect(checkSelf()).toEqual([]);
    });
});

describe("checkAll", () => {
    it("finds no undeclared import anywhere in the workspace", () => {
        expect(checkAll()).toEqual([]);
    });
});
