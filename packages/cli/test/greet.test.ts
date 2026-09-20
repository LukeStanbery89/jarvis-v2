import { describe, expect, it } from "vitest";
import { greet } from "../src/greet";

describe("greet", () => {
    it("returns 'Hello World'", () => {
        expect(greet()).toBe("Hello World");
    });
});
