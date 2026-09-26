#!/usr/bin/env node
/**
 * Minimal zero-dependency static file server for generated API docs.
 *
 * Serves the directory given as the first argument (default `docs`) on the
 * port in the second argument or the `PORT` env var (default 4000), mapping
 * `/` and directory paths to their `index.html`. Backs the `docs:rest` /
 * `docs:ws` / `docs:serve` convenience scripts; paths are confined to the
 * served root (traversal-safe against siblings sharing the root's prefix).
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";

const CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
};

const root = resolve(process.argv[2] ?? "docs");
const port = Number(process.argv[3]) || Number(process.env.PORT) || 4000;

createServer(async (req, res) => {
    const raw = (req.url ?? "/").split("?")[0];
    let rel;
    try {
        rel = decodeURIComponent(raw);
    } catch {
        res.writeHead(400);
        res.end("Bad request");
        return;
    }
    const target = resolve(root, `.${rel}`);
    if (target !== root && !target.startsWith(root + sep)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }
    let file = target;
    try {
        if ((await stat(file)).isDirectory()) {
            file = normalize(file + sep + "index.html");
        }
    } catch {
        // falls through to the read (404 path)
    }
    try {
        const body = await readFile(file);
        res.writeHead(200, {
            "Content-Type":
                CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        });
        res.end(body);
    } catch {
        res.writeHead(404);
        res.end("Not found");
    }
}).listen(port, () => {
    console.log(`Serving ${root} at http://localhost:${port}`);
});
