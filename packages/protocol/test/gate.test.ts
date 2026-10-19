/**
 * Gate tests (#90 phase 8f).
 *
 * A gate is a small value with two jobs: it must refuse anything that is not a
 * check a person could have meant, and its *identity* must be stable, because the
 * runner compares one firing's identity with the last one's before it compares
 * their answers. Both halves are pure, so both are asserted here rather than
 * discovered by a job that skips forever or runs on every poll.
 */
import { describe, expect, it } from "vitest";
import {
    GATE_CONDITIONS,
    gateKey,
    MAX_GATE_ARGS_LENGTH,
    MAX_GATE_TOOL_LENGTH,
    parseJobGate,
} from "../src/gate";

/** The gate the plan's example uses: a door sensor, read before every firing. */
const door = {
    tool: "homeAssistant",
    args: { action: "get", entity_id: "binary_sensor.front_door" },
    when: "changed",
};

describe("parseJobGate", () => {
    it("accepts a read the runner can make", () => {
        expect(parseJobGate(door)).toEqual({ ok: true, gate: door });
    });

    it("treats absent arguments as none", () => {
        // A gate over a tool that takes nothing is still a gate: the read is the
        // whole argument list. `args` defaults rather than being required so a
        // model writing `{tool, when}` is not refused for a missing empty object.
        expect(
            parseJobGate({ tool: "homeAssistant", when: "changed" }),
        ).toEqual({
            ok: true,
            gate: { tool: "homeAssistant", args: {}, when: "changed" },
        });
    });

    it("refuses a value that is not an object", () => {
        for (const value of [null, "changed", 42, [], true]) {
            const parsed = parseJobGate(value);
            expect(parsed.ok).toBe(false);
        }
    });

    it("refuses an unknown field rather than ignoring it", () => {
        // A field the protocol does not define is a version mismatch or a typo,
        // and silently dropping it would store a check nobody wrote.
        const parsed = parseJobGate({ ...door, threshold: 5 });
        expect(parsed).toEqual({
            ok: false,
            reason: 'unknown gate field "threshold"',
        });
    });

    it("refuses a tool name that is missing, empty, or over-long", () => {
        for (const tool of [
            undefined,
            "",
            "x".repeat(MAX_GATE_TOOL_LENGTH + 1),
        ]) {
            expect(parseJobGate({ ...door, tool }).ok).toBe(false);
        }
        // The bound itself is inclusive.
        expect(
            parseJobGate({ ...door, tool: "x".repeat(MAX_GATE_TOOL_LENGTH) })
                .ok,
        ).toBe(true);
    });

    it("refuses arguments that are not an object", () => {
        for (const args of ["get", 3, ["get"], null]) {
            // `null` is refused like any other non-object: the default covers
            // *absent* arguments, and an explicit null is a mistake worth
            // surfacing rather than a shorthand for "none".
            expect(parseJobGate({ ...door, args }).ok).toBe(false);
        }
    });

    it("refuses arguments that are too large to keep on every run", () => {
        const parsed = parseJobGate({
            ...door,
            args: { action: "get", query: "x".repeat(MAX_GATE_ARGS_LENGTH) },
        });
        expect(parsed.ok).toBe(false);
    });

    it("accepts every declared condition and refuses any other", () => {
        for (const when of GATE_CONDITIONS) {
            expect(parseJobGate({ ...door, when }).ok).toBe(true);
        }
        expect(parseJobGate({ ...door, when: "rising" })).toEqual({
            ok: false,
            reason: `"when" must be one of ${GATE_CONDITIONS.join(", ")}`,
        });
        expect(parseJobGate({ ...door, when: undefined }).ok).toBe(false);
    });
});

describe("gateKey", () => {
    it("is the same question however its arguments were ordered", () => {
        // The runner stores this beside every answer, and a key that changed when
        // JSON key order changed would make each firing look like a new question
        // — every one of them running the payload the gate exists to skip.
        const a = parseJobGate(door);
        const b = parseJobGate({
            tool: "homeAssistant",
            args: { entity_id: "binary_sensor.front_door", action: "get" },
            when: "changed",
        });
        expect(a.ok && b.ok).toBe(true);
        if (a.ok && b.ok) {
            expect(gateKey(a.gate)).toBe(gateKey(b.gate));
        }
    });

    it("is the same for nested argument objects however they were ordered", () => {
        const a = parseJobGate({
            ...door,
            args: { action: "get", attributes: { a: 1, b: 2 } },
        });
        const b = parseJobGate({
            ...door,
            args: { attributes: { b: 2, a: 1 }, action: "get" },
        });
        expect(a.ok && b.ok).toBe(true);
        if (a.ok && b.ok) {
            expect(gateKey(a.gate)).toBe(gateKey(b.gate));
        }
    });

    it("is a different question for a different tool or entity", () => {
        const base = parseJobGate(door);
        const otherEntity = parseJobGate({
            ...door,
            args: { action: "get", entity_id: "binary_sensor.back_door" },
        });
        const otherAction = parseJobGate({
            ...door,
            args: { action: "list" },
        });
        expect(base.ok && otherEntity.ok && otherAction.ok).toBe(true);
        if (base.ok && otherEntity.ok && otherAction.ok) {
            expect(gateKey(base.gate)).not.toBe(gateKey(otherEntity.gate));
            expect(gateKey(base.gate)).not.toBe(gateKey(otherAction.gate));
        }
    });

    it("preserves argument array order, which is part of the question", () => {
        const a = parseJobGate({ ...door, args: { actions: ["get", "list"] } });
        const b = parseJobGate({ ...door, args: { actions: ["list", "get"] } });
        expect(a.ok && b.ok).toBe(true);
        if (a.ok && b.ok) {
            expect(gateKey(a.gate)).not.toBe(gateKey(b.gate));
        }
    });
});
