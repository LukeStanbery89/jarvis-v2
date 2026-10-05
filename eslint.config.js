/**
 * ESLint flat config for the whole workspace.
 *
 * Scope: every workspace package plus the root tooling scripts. Runs without
 * type information (`tseslint.configs.recommended` rather than
 * `recommendedTypeChecked`) so linting stays fast and does not need a second
 * `tsc` program; `npm run typecheck` is the authority on types.
 *
 * Style is deliberately NOT linted here. Prettier owns formatting, and
 * `eslint-config-prettier` sits last to turn off every stylistic rule that
 * would otherwise conflict with it -- otherwise the two tools fight and
 * `npm run check` fails on formatting nobody asked it to change.
 */
const tseslint = require("typescript-eslint");
const prettierConfig = require("eslint-config-prettier");

/**
 * Builds the shared language block for one file group.
 *
 * @param {string[]} files Glob patterns the block applies to.
 * @returns {import("eslint").Linter.Config[]} flat-config entries.
 */
function rulesFor(files) {
    return [
        {
            files,
            extends: [tseslint.configs.recommended],
            rules: {
                /**
                 * Keep `any` deliberate. LangGraph's compiled-graph generics
                 * were the historical offender; the dozen-argument
                 * `CompiledStateGraph` alias now lives behind a single named
                 * type in `packages/server/src/llm/agentGraph.ts`, so any new
                 * `any` is a decision rather than an accident.
                 */
                "@typescript-eslint/no-explicit-any": "error",

                /**
                 * Flag unused bindings, but do not demand the
                 * `varsIgnorePattern` a stricter setup would. Several
                 * constructor parameters exist to satisfy an interface or a
                 * DI signature without being read in the body.
                 */
                "@typescript-eslint/no-unused-vars": [
                    "error",
                    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
                ],

                /**
                 * The packages compile to CommonJS (`tsconfig.base.json` sets
                 * `module: commonjs`) but the sources are written as ESM.
                 * A `require()` in source means a CommonJS-ism slipped into
                 * ESM-authored code, which breaks the `contracts` package when
                 * it resolves its own `package.json`.
                 */
                "@typescript-eslint/no-require-imports": "error",

                /**
                 * Ban `let` without a reassignment. A `let` that is never
                 * written again should be `const`; this catches the common
                 * case without the false positives of `prefer-const`.
                 */
                "prefer-const": "error",

                eqeqeq: ["error", "smart"],
                "no-var": "error",
            },
        },
    ];
}

module.exports = tseslint.config(
    {
        // Never lint build output, dependencies, or graphify's generated artifacts.
        ignores: [
            "**/node_modules/**",
            "**/dist/**",
            "**/.docs/**",
            "graphify-out/**",
            "coverage/**",
        ],
    },
    ...rulesFor(["**/*.ts", "**/*.tsx"]),
    ...rulesFor(["scripts/**/*.mjs"]),
    {
        // Test files may use `any` to poke at internal shapes, and unused
        // bindings are common in fixtures.
        files: [
            "**/test/**/*.{ts,tsx}",
            "**/*.test.{ts,tsx}",
            "scripts/**/*.test.mjs",
        ],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
        },
    },
    {
        // Generated OpenAPI types are not hand-maintained.
        files: ["packages/contracts/src/generated/**"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": "off",
        },
    },
    prettierConfig,
    {
        files: ["**/vite.config.ts", "**/vitest.config.ts"],
        // Vite config is ESM-only at runtime regardless of the CJS tsc target.
        languageOptions: { sourceType: "module" },
    },
);
