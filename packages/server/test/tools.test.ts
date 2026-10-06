import { describe, expect, it } from "vitest";
import { calculateResult } from "../src/llm/tools/math";
import { clockFacet, localClock } from "../src/llm/tools/time";
import { createTools } from "../src/llm/tools";
import type { ToolDeps } from "../src/llm/tools";
import { DEFAULT_HA_LIGHT_TOKENS } from "../src/config";
import { FixedWindowQuota } from "../src/rate/fixedWindowQuota";
import type { HomeAssistantProvider } from "../src/llm/tools/homeAssistant/types";

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

describe("clockFacet", () => {
    it("classifies time, date, and weekday asks", () => {
        expect(clockFacet("What time is it?")).toBe("time");
        expect(clockFacet("What's the current time now?")).toBe("time");
        expect(clockFacet("What's today's date?")).toBe("date");
        expect(clockFacet("What date is it?")).toBe("date");
        expect(clockFacet("What day of the week is it?")).toBe("weekday");
        expect(clockFacet("What weekday is it?")).toBe("weekday");
    });

    it("classifies 'what day is it' asks as the full form", () => {
        expect(clockFacet("What day is it?")).toBe("full");
        expect(clockFacet("What day is today?")).toBe("full");
        expect(clockFacet("Today, what day is this?")).toBe("full");
    });

    it("falls back to the full form for unrecognized phrasing", () => {
        expect(clockFacet("Do you know what it is today?")).toBe("full");
        expect(clockFacet("")).toBe("full");
    });
});

describe("localClock", () => {
    // The CI timezone is whatever it is; assert against local Date getters on
    // a known instant rather than a fixed wall-clock string.
    const instant = new Date("2026-09-22T12:34:56Z");
    const hours = instant.getHours();
    const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    const meridiem = hours < 12 ? "AM" : "PM";
    const minute = String(instant.getMinutes()).padStart(2, "0");

    it("time ask returns just hour, minute, and AM/PM", () => {
        const output = localClock("What time is it?", instant);
        expect(output).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
        expect(output).toBe(`${hour12}:${minute} ${meridiem}`);
    });

    it("date ask returns Month day, year", () => {
        const output = localClock("What's today's date?", instant);
        expect(output).toMatch(/^[A-Za-z]+ \d{1,2}, \d{4}$/);
        expect(output).toContain(String(instant.getFullYear()));
    });

    it("weekday ask returns just the day of the week", () => {
        const output = localClock("What day of the week is it?", instant);
        expect(output).toMatch(/^[A-Za-z]+$/);
        expect(output.length).toBeLessThan(12);
    });

    it("what-day-is-it ask returns weekday with the full date", () => {
        const output = localClock("What day is it?", instant);
        expect(output).toMatch(/^[A-Za-z]+, [A-Za-z]+ \d{1,2}, \d{4}$/);
        const weekday =
            instant.getDay() === 0
                ? "Sunday"
                : [
                      "Sunday",
                      "Monday",
                      "Tuesday",
                      "Wednesday",
                      "Thursday",
                      "Friday",
                      "Saturday",
                  ][instant.getDay()];
        expect(output).toContain(weekday);
        expect(output).toContain(String(instant.getFullYear()));
    });
});

describe("createTools wiring", () => {
    /**
     * Names of the tools registered for a given dependency set.
     *
     * Only the optional dependencies are exercised here — the required
     * vision/attachment deps are not this test's subject, so a partial set is
     * cast rather than stubbed through three unrelated fakes.
     */
    const names = (deps?: Partial<ToolDeps>): string[] =>
        createTools(deps as ToolDeps | undefined).map((tool) => tool.name);

    it("registers homeAssistant only when its deps are present (#15)", () => {
        expect(names()).not.toContain("homeAssistant");
        expect(
            names({
                homeAssistant: {
                    provider: {} as HomeAssistantProvider,
                    quota: new FixedWindowQuota(10),
                    controlDomains: ["light"],
                    listLimit: 40,
                    lightTokens: DEFAULT_HA_LIGHT_TOKENS,
                },
            }),
        ).toContain("homeAssistant");
    });

    it("always keeps the built-in tools alongside the optional ones", () => {
        expect(names()).toEqual(["getCurrentTime", "calculate"]);
    });
});
