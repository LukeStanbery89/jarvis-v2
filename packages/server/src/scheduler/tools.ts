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
