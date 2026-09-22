import { describe, expect, it } from "vitest";
import { calculateResult } from "../src/llm/tools/math";
import { localClock } from "../src/llm/tools/time";

const CASES: Array<[string, number]> = [
    ["42", 42],
    ["1 + 2", 3],
    ["3 + 4 * 2", 11],
    ["(3 + 4) * 2", 14],
    ["10 / 4", 2.5],
    ["-5 + 3", -2],
    ["1.5 * 2", 3],
    ["2 - -3", 5],
];

describe("calculateResult", () => {
    for (const [expression, expected] of CASES) {
        it(`evaluates ${JSON.stringify(expression)} = ${expected}`, () => {
            expect(calculateResult(expression)).toBe(expected);
        });
    }

    it("rejects malformed input", () => {
        expect(() => calculateResult("1 +")).toThrow(/unexpected end/);
        expect(() => calculateResult("(1 + 2")).toThrow(/unexpected end/);
        expect(() => calculateResult("foo")).toThrow(/unexpected token/);
        expect(() => calculateResult("1 2")).toThrow(/unexpected trailing/);
        expect(() => calculateResult("")).toThrow(/empty/);
        expect(() => calculateResult("1 / 0")).toThrow(/division by zero/);
    });
});

describe("localClock", () => {
    it("formats the wall-clock with the local UTC offset", () => {
        // The CI timezone is whatever it is; assert the shape and that the
        // wall-clock agrees with local Date getters on a known instant.
        const instant = new Date("2026-09-22T12:34:56Z");
        const output = localClock(instant);
        expect(output).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2}$/,
        );
        const hour = String(instant.getHours()).padStart(2, "0");
        const minute = String(instant.getMinutes()).padStart(2, "0");
        const second = String(instant.getSeconds()).padStart(2, "0");
        expect(output).toContain(`T${hour}:${minute}:${second}`);
    });

    it("carries the exact machine offset, whatever the CI timezone", () => {
        const instant = new Date("2026-09-22T12:34:56Z");
        const output = localClock(instant);
        const abs = Math.abs(instant.getTimezoneOffset());
        const sign = instant.getTimezoneOffset() <= 0 ? "+" : "-";
        const offset = `${sign}${String(Math.floor(abs / 60)).padStart(
            2,
            "0",
        )}:${String(abs % 60).padStart(2, "0")}`;
        expect(output).toContain(`UTC${offset}`);
    });
});
