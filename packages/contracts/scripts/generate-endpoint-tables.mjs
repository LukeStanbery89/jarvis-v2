#!/usr/bin/env node
/**
 * Generates the canonical endpoint tables for the API specs.
 *
 * Reads `spec/openapi.yaml` (REST) and `spec/asyncapi.yaml` (WebSocket) and
 * writes `docs/endpoints-rest.md` and `docs/endpoints-ws.md`. Run via
 * `npm run docs:endpoints` from the package; `npm run check:endpoints`
 * re-runs the generation and fails when the committed tables drift, keeping
 * the tables as current as the specs. Consumers: `packages/server` README +
 * AGENTS.
 *
 * Auth mapping for the REST table: OpenAPI `security` requirements at the
 * operation level (the spec's root `security: []` means every route decides
 * its own). The scheme order matches the spec's "either" operator, and the
 * one operation without a scheme — `POST /api/bootstrap` — is gated by the
 * `x-bootstrap-token` header instead, which the table reports in its own
 * column value.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load as loadYaml } from "js-yaml";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const REST_TABLE_HEADER = `# REST endpoint table

Source of truth: \`spec/openapi.yaml\` (regenerate with
\`npm run docs:endpoints\` from \`packages/contracts\`).

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
`;

const WS_TABLE_HEADER = `# WebSocket channel table

Source of truth: \`spec/asyncapi.yaml\` (regenerate with
\`npm run docs:endpoints\` from \`packages/contracts\`).

| Operation | Action | Messages | Summary |
| --------- | ------ | -------- | ------- |
`;

/**
 * Loads a spec YAML file relative to the package root and returns the parsed
 * document.
 */
function loadSpec(relativePath) {
    return loadYaml(readFileSync(join(packageRoot, relativePath), "utf8"));
}

/**
 * Maps an OpenAPI `security` requirement array to a short auth label.
 *
 * The spec uses two schemes: `bearerToken` (device token) and `session`
 * (cookie); an operation listing both means "either". Any future scheme
 * falls back to its key name rather than being silently miscalled.
 */
function authLabel(security) {
    if (!Array.isArray(security) || security.length === 0) {
        return "none";
    }
    const schemes = security.map((requirement) => Object.keys(requirement)[0]);
    if (
        schemes.every((scheme) => ["bearerToken", "session"].includes(scheme))
    ) {
        return schemes.includes("session")
            ? "device token or web session"
            : "device token";
    }
    return schemes.join(" or ");
}

/**
 * Detects the `x-bootstrap-token` header parameter (the spec's sole
 * no-security-scheme route, `POST /api/bootstrap`) via its `$ref`, and
 * returns a label for it, else null.
 */
function bootstrapHeaderLabel(operation) {
    const hasBootstrapHeader = (operation.parameters ?? []).some(
        (p) => p.$ref === "#/components/parameters/XBootstrapToken",
    );
    return hasBootstrapHeader ? "x-bootstrap-token header" : null;
}

/** First non-empty line of an operation's summary or description, or "—". */
function operationSummary(operation) {
    const summary = operation.summary ?? "";
    if (summary.trim() !== "") return summary;
    const described = (operation.description ?? "").split("\n")[0].trim();
    return described !== "" ? described : "—";
}

/** Renders the markdown table for every path/method in the OpenAPI spec. */
function renderRestTable(spec) {
    const rows = [];
    for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
        for (const [method, operation] of Object.entries(pathItem)) {
            if (!method.match(/^(get|post|put|patch|delete)$/)) continue;
            const auth =
                bootstrapHeaderLabel(operation) ??
                authLabel(operation.security);
            rows.push(
                `| \`${method.toUpperCase()}\` | \`${path}\` | ${auth} | ${operationSummary(
                    operation,
                )} |`,
            );
        }
    }
    return REST_TABLE_HEADER + rows.join("\n") + "\n";
}

/**
 * Lists the spec message names an AsyncAPI 3 operation's `messages` refs
 * point at, in spec declaration order.
 */
function operationMessages(operation) {
    return (operation.messages ?? [])
        .map((message) => message.$ref?.split("/").pop() ?? "")
        .filter(Boolean)
        .join(", ");
}

/** Renders the table for every operation in the AsyncAPI spec. */
function renderWsTable(spec) {
    const rows = [];
    for (const [operationId, operation] of Object.entries(
        spec.operations ?? {},
    )) {
        rows.push(
            `| \`${operationId}\` | ${operation.action} | ${operationMessages(
                operation,
            )} | ${operationSummary(operation)} |`,
        );
    }
    return WS_TABLE_HEADER + rows.join("\n") + "\n";
}

/**
 * Regenerates `docs/endpoints-rest.md` and `docs/endpoints-ws.md` from the
 * specs; the committed files must match this output exactly.
 */
function main() {
    mkdirSync(join(packageRoot, "docs"), { recursive: true });
    writeFileSync(
        join(packageRoot, "docs", "endpoints-rest.md"),
        renderRestTable(loadSpec("spec/openapi.yaml")),
    );
    writeFileSync(
        join(packageRoot, "docs", "endpoints-ws.md"),
        renderWsTable(loadSpec("spec/asyncapi.yaml")),
    );
    console.log("Wrote docs/endpoints-rest.md and docs/endpoints-ws.md");
}

/* Only run on direct invocation so the render functions stay importable
   (unit tests can diff renderRestTable/renderWsTable output). */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main();
}
