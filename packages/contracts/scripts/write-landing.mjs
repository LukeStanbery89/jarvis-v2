#!/usr/bin/env node
/**
 * Writes the `.docs/index.html` landing page linking the REST and WebSocket
 * reference builds.
 *
 * Runs as the leading step of `npm run docs:build`; the file rides the
 * GitHub Pages artifact (`docs.yml`) so the published site root resolves to a
 * page instead of 404ing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(packageRoot, ".docs");

const page = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>J.A.R.V.I.S. API reference</title>
        <style>
            body {
                font-family: system-ui, sans-serif;
                max-width: 40rem;
                margin: 4rem auto;
                padding: 0 1rem;
                line-height: 1.6;
            }
        </style>
    </head>
    <body>
        <h1>J.A.R.V.I.S. API reference</h1>
        <p>Generated from the contract-first specs in <code>packages/contracts/spec/</code>.</p>
        <ul>
            <li><a href="/rest/">REST management API (OpenAPI)</a> — <code>/api</code> routes + <code>GET /health</code></li>
            <li><a href="/ws/">WebSocket chat endpoint (AsyncAPI)</a> — <code>/ws</code> channel</li>
        </ul>
        <p>Regenerate locally with <code>npm run docs:build -w @lukestanbery/jarvis-contracts</code>.</p>
    </body>
</html>
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "index.html"), page);
console.log("Wrote .docs/index.html");
