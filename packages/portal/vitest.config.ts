import { defineConfig } from "vitest/config";

/**
 * Vitest runs the portal's unit tests (currently the api layer) in the Node
 * environment — `fetch` is global since Node 18 — so no browser/jsdom setup is
 * needed and no DOM-testing libraries are installed.
 */
export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
    },
});
