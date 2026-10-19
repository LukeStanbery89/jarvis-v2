/**
 * Which tools a scheduled job may call (#90).
 *
 * An explicit allowlist rather than "whatever the graph happens to have",
 * because a stored tool call is a **durable capability**: the model chose it
 * when the job was scheduled, and it executes later with nobody watching. A
 * tool that needs a live conversation (something to analyse, a device to
 * report from) or one that schedules (a job creating jobs) must not be in here
 * — and a tool added to the registry tomorrow is not schedulable until
 * somebody decides it is, which is the direction the mistake should fall.
 *
 * The check runs twice: when a job is created (phase 3's tool, so the refusal
 * is immediate and model-facing) and again when it fires (`resolveSchedulableTool`
 * below), because a server's configuration can change between the two — the
 * Home Assistant credentials may be gone by the time the lights were supposed
 * to come on.
 */
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { JobGate } from "@lukestanbery/jarvis-protocol";

/**
 * The names a job may schedule.
 *
 * Two deliberate omissions:
 *
 * - `analyzeImage` resolves attachment ids that belong to a live conversation.
 * - `sendNotification` **is the announcement mechanism, not a payload.** The
 *   runner already announces every run with the job's own text, so scheduling
 *   the notification tool would fire twice for one job — which is exactly what
 *   the first end-to-end smoke test showed. A scheduled thing that wants to say
 *   something says it through its job (phase 2 gives a reminder or timer its
 *   own message payload), not by calling the tool a chat turn uses when the
 *   assistant decides to interrupt.
 *
 * The `jobs` tool itself is out too (phase 3): a job that schedules jobs is a
 * loop nobody asked for.
 */
export const SCHEDULABLE_TOOLS: readonly string[] = [
    "homeAssistant",
    "webSearch",
    "getWeather",
    "wikipedia",
    "getCurrentTime",
    "calculate",
];

/** Whether `name` is one a job may call. */
export function isSchedulableTool(name: string): boolean {
    return SCHEDULABLE_TOOLS.includes(name);
}

/**
 * The actions of each tool that may be used as a **gate** (#90 phase 8f).
 *
 * `SCHEDULABLE_TOOLS` does not separate reads from writes — `homeAssistant` is
 * one name over `get` *and* `turn_on` — so gateability cannot be inferred from
 * "the tool has no writes": it has to be declared, per tool and per action. An
 * action that appears here only reads, which is what a gate needs, because a gate
 * that *wrote* to compare its effect and then wrote again would be neither
 * deterministic nor free.
 *
 * Absence from this map means "cannot be a gate", and that is the direction the
 * mistake should fall. The read-only tools are deliberately not here yet, and not
 * because they write: `webSearch` would answer differently on every poll, so a
 * `changed` gate over it would fire every time — the flood a gate exists to
 * prevent. Each entry is a promise that the action's answer is **stable while
 * nothing changes**, and only `homeAssistant` was verified against that
 * (`get` renders `name [id]: state`, never `last_changed`).
 *
 * The values are checked against the tool's own `action` argument, which is the
 * one argument every gateable tool so far discriminates with.
 */
export const GATE_ACTIONS: Record<string, readonly string[]> = {
    homeAssistant: ["list", "lights", "switches", "get"],
};

/**
 * Why `gate` cannot be used as a check, or `null` when it can.
 *
 * Written to be read by a model turn (the scheduling tool's refusal, phase 8g) as
 * well as by the runner's log, so it says which actions *are* readable rather
 * than only that this one is not.
 *
 * @param gate - A structurally valid gate (see `parseJobGate`).
 * @returns The refusal, or `null`.
 */
export function gateRefusal(gate: JobGate): string | null {
    const readable = GATE_ACTIONS[gate.tool];
    if (readable === undefined) {
        const gateable = Object.keys(GATE_ACTIONS).join(", ");
        return `'${gate.tool}' cannot check a job — only ${gateable} can, and only with a read action`;
    }
    const action = gate.args.action;
    if (typeof action !== "string" || !readable.includes(action)) {
        return `a gate may only read with '${gate.tool}' (${readable.join(", ")})`;
    }
    return null;
}

/** The outcome of resolving a job's gate: the tool instance, or why it cannot read. */
export type ResolvedGateTool =
    { ok: true; tool: StructuredToolInterface } | { ok: false; reason: string };

/**
 * Finds the tool instance a job's gate should call, or says why it cannot.
 *
 * The same two-layer check a scheduled target gets, for the same reason: the
 * policy decides whether a gate is *allowed*, and the registry decides whether it
 * is *possible right now* — the Home Assistant credentials may be gone by the
 * time the check was supposed to run at 3am. The reason is written to be read by
 * a person; it ends up in the run row and in the failure that says why the job
 * did not run.
 *
 * @param tools - The instances the agent graph was built with.
 * @param gate - A structurally valid gate.
 * @returns The tool to invoke, or the refusal to record.
 */
export function resolveGateTool(
    tools: readonly StructuredToolInterface[],
    gate: JobGate,
): ResolvedGateTool {
    const refused = gateRefusal(gate);
    if (refused !== null) {
        return { ok: false, reason: refused };
    }
    const resolved = resolveSchedulableTool(tools, gate.tool);
    if (!resolved.ok) {
        return { ok: false, reason: resolved.reason };
    }
    return { ok: true, tool: resolved.tool };
}

/** The outcome of resolving a job's tool: the instance, or why it cannot run. */
export type ResolvedTool =
    { ok: true; tool: StructuredToolInterface } | { ok: false; reason: string };

/**
 * Finds the tool instance a job should invoke, or says why it cannot.
 *
 * The reason is written to be read by a person — it ends up in the job's run
 * history and in the notification that says the job failed, so "the
 * 'homeAssistant' tool is not available on this server" is the sentence that
 * explains a 20:00 job that never turned the light on.
 */
export function resolveSchedulableTool(
    tools: readonly StructuredToolInterface[],
    name: string,
): ResolvedTool {
    if (!isSchedulableTool(name)) {
        return {
            ok: false,
            reason: `'${name}' cannot be scheduled`,
        };
    }
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
        return {
            ok: false,
            reason: `the '${name}' tool is not available on this server`,
        };
    }
    return { ok: true, tool };
}
