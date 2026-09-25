/**
 * Sanity tests for the spec documents in this package.
 *
 * They guard against committing a truncated/corrupt YAML file and pin the
 * spec major versions the tooling targets (OpenAPI 3.1, AsyncAPI 3.1). Full
 * conformance checking happens through `npm run lint` / `npm run validate` /
 * the later-phase frame-conformance suite; these are cheap smoke checks that
 * also keep `vitest run` meaningful in an otherwise spec-only package.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";

import { ASYNCAPI_SPEC, OPENAPI_SPEC } from "../src";

// Vitest runs from the package root (npm workspaces), so `process.cwd()` is
// the package directory. `import.meta` is unavailable here: the typecheck
// build keeps the repo-wide CommonJS module setting.
const packageRoot = process.cwd();

/** Reads and parses one of the package's spec files into a plain object. */
function readSpec(relativePath: string): Record<string, unknown> {
    const abs = path.join(packageRoot, relativePath);
    expect(fs.existsSync(abs), `missing spec file: ${relativePath}`).toBe(true);
    return loadYaml(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
}

describe("OpenAPI spec (REST)", () => {
    it("is a parseable OpenAPI 3.1 document with a header", () => {
        const doc = readSpec(OPENAPI_SPEC);
        expect(doc.openapi).toMatch(/^3\.1\./);
        expect(doc.info).toEqual(
            expect.objectContaining({ title: expect.any(String) }),
        );
    });

    it("declares a paths container for later endpoint authoring", () => {
        const doc = readSpec(OPENAPI_SPEC);
        expect(doc).toHaveProperty("paths");
    });
});

describe("AsyncAPI spec (WebSocket)", () => {
    it("is a parseable AsyncAPI 3.1 document with a header", () => {
        const doc = readSpec(ASYNCAPI_SPEC);
        expect(doc.asyncapi).toMatch(/^3\./);
        expect(doc.info).toEqual(
            expect.objectContaining({ title: expect.any(String) }),
        );
    });

    it("declares channels and operations containers for later frame authoring", () => {
        const doc = readSpec(ASYNCAPI_SPEC);
        expect(doc).toHaveProperty("channels");
        expect(doc).toHaveProperty("operations");
    });
});
