import { describe, expect, it } from "vitest";
import { calculateResult } from "../src/llm/tools/math";

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
