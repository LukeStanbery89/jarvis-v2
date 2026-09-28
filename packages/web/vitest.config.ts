import { defineConfig } from "vitest/config";

/**
 * Vitest runs the web client's unit tests in the Node environment — pure
 * helpers (URL derivation, and from the next phase the client frame loop) do
 * not need a browser or DOM-testing libraries.
 */
export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
    },
});
