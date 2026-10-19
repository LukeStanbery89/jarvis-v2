/**
 * The deterministic check a scheduled job runs before its payload (#90 phase 8f).
 *
 * A job that fires every five minutes cannot afford to ask a model every five
 * minutes, and a reminder cannot afford to *speak* every five minutes. So a job
 * may carry a **gate**: one read-only tool call, whose answer is compared with
 * the answer at the previous firing. The same answer to the same question means
 * nothing changed, so the firing declines — a `skipped` run row, no payload, no
 * announcement, no tokens. A different answer runs the payload as any other
 * firing would.
 *
 * This lives in the protocol package for the same reason {@link JobRepeat} does:
 * the value is written at one end and read at another — the scheduling tool
 * stores it, the runner evaluates it, the run row remembers what it saw — so one
 * implementation of its *shape* is what keeps those ends from disagreeing. The
 * **policy** of which tool may be checked, and with which of its actions, is the
 * server's (`scheduler/tools.ts` owns that map), because it is a statement about
 * the tools a particular deployment has wired.
 *
 * Only one comparison is offered, deliberately: `changed`. A richer condition
 * ("if the light is on and it is after sunset") is either a predicate language
 * or a model call, and half of one would be worse than an honest refusal.
 *
 * The one property the rest of the design leans on: **a gate's output must be
 * stable while nothing changes.** A volatile read would answer "different" on
 * every poll, which turns an affordable minutely job into a flood of
 * announcements — the exact cost the gate exists to avoid. That is why a gate is
 * declared per tool and per action rather than offered wherever a call happens
 * to be read-only.
 */

/** The comparisons a gate can make. */
export const GATE_CONDITIONS = ["changed"] as const;

/** How a gate decides whether a firing is worth running. */
export type GateCondition = (typeof GATE_CONDITIONS)[number];

/** The longest tool name a gate may name (the bound tool names use elsewhere). */
export const MAX_GATE_TOOL_LENGTH = 64;

/**
 * The longest serialized argument object a gate may carry.
 *
 * Generous for what a gate is — an action and an entity id — and bounded because
 * of where these arguments also go: the gate's *identity* is stored on every run
 * row, and a run row is written 288 times a day by the job a gate makes
 * affordable.
 */
export const MAX_GATE_ARGS_LENGTH = 2000;

/**
 * A job's gate: what is checked before the payload, and how.
 *
 * Every field is validated by {@link parseJobGate}; construct gates through it
 * rather than by hand, so a malformed one cannot reach the scheduler.
 */
export interface JobGate {
    /** The read-only tool the check calls. */
    tool: string;
    /** Its arguments: one call, whose answer is compared between firings. */
    args: Record<string, unknown>;
    /** The comparison. `changed` is the only one the protocol defines. */
    when: GateCondition;
}

/** The outcome of validating a stored or requested gate. */
export type GateParseResult =
    { ok: true; gate: JobGate } | { ok: false; reason: string };

/**
 * Validates a gate, refusing with a reason written to be read by a person.
 *
 * The reason reaches a model turn (a scheduling tool's refusal) or a log line
 * (a stored value that stopped making sense), so it names the field rather than
 * quoting a stack.
 *
 * @param value - The candidate, usually parsed JSON from a job row or a tool call.
 * @returns The gate, or why it is not one.
 */
export function parseJobGate(value: unknown): GateParseResult {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, reason: "a gate must be an object" };
    }
    const raw = value as Record<string, unknown>;
    const known = new Set(["tool", "args", "when"]);
    for (const key of Object.keys(raw)) {
        if (!known.has(key)) {
            return { ok: false, reason: `unknown gate field "${key}"` };
        }
    }

    const tool = raw.tool;
    if (
        typeof tool !== "string" ||
        tool.length === 0 ||
        tool.length > MAX_GATE_TOOL_LENGTH
    ) {
        return {
            ok: false,
            reason: `"tool" must be a tool name of at most ${MAX_GATE_TOOL_LENGTH} characters`,
        };
    }

    const args = raw.args === undefined ? {} : raw.args;
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return { ok: false, reason: '"args" must be an object' };
    }
    let serialized: string;
    try {
        serialized = JSON.stringify(args) ?? "null";
    } catch {
        return { ok: false, reason: '"args" must be JSON' };
    }
    if (serialized.length > MAX_GATE_ARGS_LENGTH) {
        return {
            ok: false,
            reason: `"args" must be at most ${MAX_GATE_ARGS_LENGTH} characters of JSON`,
        };
    }

    const when = raw.when;
    if (
        typeof when !== "string" ||
        !(GATE_CONDITIONS as readonly string[]).includes(when)
    ) {
        return {
            ok: false,
            reason: `"when" must be one of ${GATE_CONDITIONS.join(", ")}`,
        };
    }

    return {
        ok: true,
        gate: {
            tool,
            args: args as Record<string, unknown>,
            when: when as GateCondition,
        },
    };
}

/**
 * The gate's identity: the question, as one string.
 *
 * Two firings are comparable only when they asked the *same* thing, so the runner
 * stores this beside every answer it observes and compares it before comparing
 * answers. `{ tool, args }` rather than the whole gate, because `when` describes
 * the relation between answers rather than the question; object keys are sorted
 * so that an argument written in a different order is the same question instead
 * of a different one.
 *
 * @param gate - A validated gate.
 * @returns A stable string identity for the check.
 */
export function gateKey(gate: JobGate): string {
    return canonical({ tool: gate.tool, args: gate.args });
}

/**
 * JSON with object keys in sorted order, so equal values render identically.
 *
 * Private to {@link gateKey}: the sort is what makes the identity canonical, and
 * nothing else needs a second JSON serializer.
 */
function canonical(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(",")}]`;
    }
    if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        const fields = Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
        return `{${fields.join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
