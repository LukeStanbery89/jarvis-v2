import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PORT, getServerPort } from "../src/config";

afterEach(() => {
    delete process.env.PORT;
});

describe("getServerPort", () => {
    it("defaults to the served port", () => {
        delete process.env.PORT;
        expect(getServerPort()).toBe(DEFAULT_PORT);
    });

    it("reads PORT", () => {
        process.env.PORT = "8080";
        expect(getServerPort()).toBe(8080);
    });

    it("is overridable with 0 (ephemeral bind)", () => {
        process.env.PORT = "0";
        expect(getServerPort()).toBe(0);
    });
});
