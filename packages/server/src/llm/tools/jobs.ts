/**
 * The scheduling tools (#90 phase 3): the model's way to create, inspect and
 * cancel fire-at-T jobs.
 *
 * Seven tools, and their split is the invariant. **The class comes from which
 * tool was called, never from an argument.** `setTimer` always stores `timer`
 * (it interrupts, even in quiet hours), `remindMe` always stores `reminder` (it
 * waits out the window), and `scheduleTask`/`schedulePrompt` always store
 * `notification` (they are filed, not announced). No tool exposes `class` or
 * `priority`, because either would be a way for the model to choose how loudly
 * the user is interrupted — the exact reach the notification design removed from
 * `priority` (#139/#90).
 *
 * The rest of the policy stays where it already lives:
 *
 * - **What may be created, and what a snooze may touch** is
 *   `scheduler/create.ts` (#90 phase 5) — one policy for these tools and the
 *   REST surface a page uses, so the two doors cannot drift. This file renders
 *   its outcomes in the model's voice.
 * - **When** is resolved by `scheduler/time.ts` — the model supplies the words
 *   ("08:30", "tomorrow", "in 10 minutes"), never a timestamp. The resolver owns
 *   next-occurrence, past-date and weekday rules, and its zone is the server's
 *   local clock, the same one `getCurrentTime` reports.
 * - **Whether a tool may be scheduled** is `scheduler/tools.ts`: creation goes
 *   through the same allowlist the runner enforces, plus that tool's own zod
 *   schema, so an impossible task is refused *now*, while the user is still
 *   here, instead of failing silently at 7am. A **gate** (#90 phase 8g) is held
 *   to the same standard: its tool must be schedulable *and* declare the action
 *   as a read, it must be installed right now, and its arguments must satisfy
 *   that tool's schema — three refusals while the user is still in the room.
 * - **What the user is told** is the announcement the runner makes, with the
 *   job's class. This file only relays what the creator predicts will happen to
 *   it (quiet hours as they stand); it never pre-defers, because the runner owns
 *   that decision and reads the prefs live at fire time.
 *
 * Every refusal is a returned string in the model's voice, never a throw, so a
 * refused request degrades into something it can relay or correct.
 */
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { requireSignedInUser } from "./metering";
import { resolveGateTool, resolveSchedulableTool } from "../../scheduler/tools";
import { resolveWhen } from "../../scheduler/time";
import {
    createJobCreator,
    MAX_DURATION_MINUTES,
    MIN_DURATION_SECONDS,
    MIN_SNOOZE_MINUTES,
} from "../../scheduler/create";
import type {
    CreateOutcome,
    JobCreatorDeps,
    JobPayload,
} from "../../scheduler/create";
import {
    describeRepeat,
    parseJobGate,
    parseJobRepeat,
} from "@lukestanbery/jarvis-protocol";
import { format12Hour } from "./clock";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AppJob } from "@lukestanbery/jarvis-auth";
import type { JobGate, NotificationClass } from "@lukestanbery/jarvis-protocol";

// Re-exported because these bounds are what a caller reads when it wants to
// know what a timer may be; their home is the creation policy.
export { MAX_DURATION_MINUTES, MIN_DURATION_SECONDS, MIN_SNOOZE_MINUTES };

/** Everything the scheduling tools need, injected at wiring time. */
export interface JobsToolDeps {
    /**
     * The ledger every tool reads and writes through — the creation policy's own
     * seam, named from it rather than restated, so widening it (a snooze now
     * settles the announcement it answered, #90 phase 6c) cannot leave the tools
     * behind with a stale subset. `AppDatabase` satisfies it; tests pass the same
     * store.
     */
    ledger: JobCreatorDeps["ledger"];
    /** How many jobs one account may have pending (`JARVIS_JOB_MAX_PER_USER`). */
    maxPerUser: number;
    /** How far ahead a job may be set (`JARVIS_JOB_MAX_HORIZON_DAYS`). */
    maxHorizonMs: number;
    /**
     * The tool instances built before these — `scheduleTask` validates a
     * requested tool against them. A snapshot, so the jobs tools can never see
     * (or schedule) themselves.
     */
    tools: readonly StructuredToolInterface[];
    /** Reads "now"; injectable so tests need no clock control. */
    now?: () => Date;
    /** Generates job ids; injectable so tests can assert them. */
    newId?: () => string;
}

/** How many pending jobs `listJobs` renders at once. */
export const LIST_LIMIT = 20;

/**
 * Builds the six scheduling tools over the injected ledger.
 *
 * Registered only when the scheduler is running (`JARVIS_SCHEDULER` not off and
 * notifications wired): a job nobody can run is a promise the server cannot
 * keep, and a tool that made one would be worse than no tool at all.
 */
export function createJobsTools(deps: JobsToolDeps): StructuredToolInterface[] {
    const now = deps.now ?? (() => new Date());
    /** The shared creation policy — the same instance the REST surface uses. */
    const creator = createJobCreator({
        ledger: deps.ledger,
        maxPerUser: deps.maxPerUser,
        maxHorizonMs: deps.maxHorizonMs,
        now: deps.now,
        newId: deps.newId,
    });

    /**
     * Stores a job through the shared creation policy.
     *
     * Thin on purpose: every bound (label, message, horizon, the pending cap,
     * the timer ceiling) and the quiet-hours forecast — which the tools append
     * to their replies — live in `scheduler/create.ts`, so the tools and the
     * pages cannot answer those questions differently. All this adds is the
     * instant the tools already have, so `created_at` and the forecast share it.
     */
    function storeJob(
        userId: number,
        request: {
            label: string;
            class: NotificationClass;
            payload: JobPayload;
            runAt: Date;
            /** The rule the model stated, already anchored (#90 phase 8d). */
            repeat?: unknown;
            at: Date;
        },
    ): CreateOutcome {
        return creator.create(userId, request);
    }

    /**
     * The rule the model stated, anchored at the moment its words resolved to.
     *
     * The anchor is the point of this function: the model names a time in words
     * and the resolver turns it into the *first occurrence*, which is exactly
     * what a rule's `start` is. Doing it here means the model never handles a
     * timestamp and a series still fires at the clock the user said.
     */
    function anchoredRule(
        stated: Record<string, unknown>,
        first: Date,
    ): Record<string, unknown> {
        return {
            ...stated,
            interval: stated.interval ?? 1,
            start: first.toISOString(),
        };
    }

    /**
     * The cadence a call stated, in whichever spelling it used (#90 8d, 8g+).
     *
     * `repeat` wins when both are present: it is the documented, stored shape,
     * and a call that sent both meant the one it wrapped. Otherwise the flat
     * fields are what the model said, and they are normalized into the same
     * object so the rest of this file — and `scheduler/create.ts`, which is the
     * only validator — sees one shape either way.
     *
     * Returns `null` for a call with no cadence at all, which is a one-shot.
     */
    function statedCadence(fields: {
        repeat?: unknown;
        every?: string;
        interval?: number;
        weekdays?: string[];
        monthDays?: number[];
        weekOrdinals?: string[];
        ends?: unknown;
    }): Record<string, unknown> | null {
        if (fields.repeat !== undefined && fields.repeat !== null) {
            return fields.repeat as Record<string, unknown>;
        }
        if (fields.every === undefined) {
            return null;
        }
        return {
            every: fields.every,
            ...(fields.interval !== undefined
                ? { interval: fields.interval }
                : {}),
            ...(fields.weekdays !== undefined
                ? { weekdays: fields.weekdays }
                : {}),
            ...(fields.monthDays !== undefined
                ? { monthDays: fields.monthDays }
                : {}),
            ...(fields.weekOrdinals !== undefined
                ? { weekOrdinals: fields.weekOrdinals }
                : {}),
            ...(fields.ends !== undefined ? { ends: fields.ends } : {}),
        };
    }

    /**
     * The instant a series should start, from the words or from the cadence.
     *
     * `resolveWhen` owns the words. When the model named none **and** the user
     * asked for a repeat, the cadence is the when: "every 30 minutes" means the
     * next one is half an hour away, "every day" means from now, daily — the
     * rule's own anchor *is* a wall clock, so anchoring at the moment of the ask
     * and letting `nextOccurrence` pick the first one is exactly that reading,
     * and it states the result back. A one-shot with no time is still refused:
     * there is nothing to derive it from.
     *
     * Correctable by construction: the reply says when the first firing lands, so
     * a user who meant "every day at 8" hears the wrong time immediately and can
     * say so.
     */
    function cadenceFirst(
        when: ReturnType<typeof resolveWhen>,
        cadence: Record<string, unknown> | null,
        at: Date,
    ): { ok: true; at: Date } | { ok: false; reason: string } {
        if (when.ok) {
            return { ok: true, at: when.at };
        }
        if (cadence === null) {
            return { ok: false, reason: when.reason };
        }
        return { ok: true, at };
    }

    /**
     * The gate a call asked for, or why it cannot be used (#90 phase 8g).
     *
     * Three questions, all asked while the user is still in the conversation so
     * the refusal can be relayed and corrected: is it well-formed (the
     * protocol's parser), may this tool be read at all (the same map the runner
     * consults), and is that tool installed on this server right now (the
     * registry). The fourth — whether the arguments fit the tool — is the same
     * `argumentsProblem` a scheduled target gets, because a gate's arguments are
     * a real call the runner will make later with nobody watching.
     */
    function gateFor(
        stated: unknown,
    ): { ok: true; gate: JobGate | null } | { ok: false; reason: string } {
        if (stated === undefined || stated === null) {
            return { ok: true, gate: null };
        }
        const parsed = parseJobGate(stated);
        if (!parsed.ok) {
            return { ok: false, reason: parsed.reason };
        }
        const resolved = resolveGateTool(deps.tools, parsed.gate);
        if (!resolved.ok) {
            return { ok: false, reason: resolved.reason };
        }
        const problem = argumentsProblem(resolved.tool, parsed.gate.args);
        if (problem !== null) {
            return { ok: false, reason: problem };
        }
        return { ok: true, gate: parsed.gate };
    }

    /** Creation guard shared by the creating tools. */
    function guard(runtime: ToolRuntime, logName: string) {
        return requireSignedInUser(runtime, {
            subject: "Scheduling",
            logName,
        });
    }

    /**
     * The model's reply for a creation, in two halves.
     *
     * `done` opens a success ("Reminder scheduled") and `refused` opens a
     * refusal ("The reminder was not set"). A second string rather than a suffix
     * on the first because appending " failed" produced "Reminder scheduled
     * failed: …" in the first live test of a refusal — broken English relayed to
     * the user as if it were the assistant's own sentence.
     */
    function scheduledText(
        words: { done: string; refused: string },
        outcome: CreateOutcome,
        at: Date,
    ): string {
        if (!outcome.ok) {
            return `${words.refused}: ${outcome.reason}`;
        }
        return `${words.done}: ${describeJob(outcome.job, at)}.${outcome.note}`;
    }

    const labelSchema = z
        .string()
        .trim()
        .min(1)
        .describe(
            "The headline the user will see, written to stand on its own " +
                "('Call Mum', 'Pasta', 'Porch lights on').",
        );

    /**
     * The cadence's fields, as the model states them (#90 phase 8d).
     *
     * There is no `start` here on purpose: the model names *when* in words
     * (`at`/`onDate`/`inMinutes`), the resolver turns that into the first
     * occurrence, and that instant becomes the rule's anchor. A model that could
     * pass a timestamp could pass a wrong one — the same discipline that keeps
     * `runAt` out of its hands. When it names no time at all, the cadence
     * supplies one (see `cadenceFirst`).
     *
     * `interval` is optional because "every week" is how people say it: omitted
     * means one. `ends.after` is a *count* rather than an end date for the same
     * reason — a count is arithmetic the model can do, a date is a timestamp it
     * cannot. An end date belongs to the page, where a picker produces one.
     *
     * Written as a factory because the same fields are offered **twice** — the
     * nested spelling is what gets stored and what a page sends, and the flat one
     * is what the first live run of a repeating reminder showed a small local
     * model actually emit:
     *
     * ```
     * { "label": "Drink water", "every": "minute", "interval": 30 }   // flat
     * { "label": "Drink water", "repeat": { "every": "minute", … } }  // nested
     * ```
     *
     * The flat call used to be *silently dropped* — `z.object` strips what it was
     * not told about — so "every half hour" arrived as "no schedule", surfaced as
     * "no time was given", and left the user with nothing to correct. A door that
     * understands what the model said beats a refusal it cannot act on, and both
     * spellings mean one thing here because they are one set of fields.
     *
     * `nested` distinguishes them: nested, `every` is what makes the object a
     * rule (so it is required); flat, its absence is simply "not repeating" (the
     * same fields are spread into a schema whose neighbours are all optional).
     */
    function cadenceFields(nested: boolean) {
        const unit = z
            .enum(["minute", "hour", "day", "week", "month"])
            .describe("The unit the interval counts in.");
        return {
            every: nested ? unit : unit.optional(),
            interval: z
                .number()
                .int()
                .min(1)
                .max(1000)
                .optional()
                .describe(
                    "How many units between repeats: 3 for 'every three " +
                        "weeks'. Omit for every one.",
                ),
            weekdays: z
                .array(z.enum(["su", "mo", "tu", "we", "th", "fr", "sa"]))
                .min(1)
                .optional()
                .describe(
                    "For a weekly (or monthly) repeat: the days of the week, " +
                        "e.g. ['mo','tu','sa'] for 'every Monday, Tuesday and " +
                        "Saturday', or all of mo-fr for 'every weekday'.",
                ),
            monthDays: z
                .array(z.number().int().min(-31).max(31))
                .min(1)
                .optional()
                .describe(
                    "For a monthly repeat: days of the month, 1-31, or " +
                        "negative to count back from the end (-1 is 'the last " +
                        "day'). [1] is 'the first of every month'.",
                ),
            weekOrdinals: z
                .array(z.string().regex(/^-?[1-5](su|mo|tu|we|th|fr|sa)$/))
                .min(1)
                .optional()
                .describe(
                    "For a monthly repeat: an ordinal weekday, like '2tu' " +
                        "('the second Tuesday') or '-1fr' ('the last Friday').",
                ),
            ends: z
                .object({ after: z.number().int().min(1) })
                .optional()
                .describe(
                    "When the series stops, in firings: { after: 4 } for " +
                        "'four times'. Omit to repeat until cancelled.",
                ),
        };
    }

    /** The nested spelling: the stored, wire and page shape. */
    const repeatSchema = z
        .object(cadenceFields(true))
        .describe(
            "How this repeats, nested. Omit for a job that runs once. You may " +
                "give these same fields at the top level instead if that is " +
                "easier — both are read the same way. A timer cannot repeat — " +
                "use remindMe for something that comes back. If the user's " +
                "phrasing could mean two different schedules, ASK which they " +
                "mean instead of choosing one.",
        );

    /**
     * A gate, as the model states it (#90 phases 8f, 8g).
     *
     * The model describes the check; it never decides whether the check is
     * *allowed* — that is the read-action allowlist, asked again at fire time.
     * `args` is optional because a check over a tool that takes none is still a
     * check; for `homeAssistant` it is how the model names the entity to watch.
     */
    const gateSchema = z
        .object({
            tool: z
                .string()
                .trim()
                .min(1)
                .describe(
                    "The read-only tool whose answer decides whether this " +
                        "runs, e.g. homeAssistant.",
                ),
            args: z
                .record(z.string(), z.unknown())
                .optional()
                .describe(
                    "That tool's arguments for the check, exactly as its own " +
                        "schema wants them — for a homeAssistant `get`, the " +
                        "entity to watch.",
                ),
            when: z
                .literal("changed")
                .describe(
                    "`changed`: run only when the check's answer differs " +
                        "from the previous firing's.",
                ),
        })
        .optional()
        .describe(
            "Run only when the check's answer changed. Use it when the user " +
                "asks for a condition — 'only if the door opened', 'only if " +
                "it changed' — and never invent one. It only reads: a tool " +
                "that acts cannot be a check. A gated job may repeat as often " +
                "as every minute, and a firing that finds nothing changed " +
                "says nothing.",
        );

    const messageSchema = z
        .string()
        .trim()
        .optional()
        .describe(
            "Optional *extra* detail delivered under the headline — never a " +
                "restatement of it. Leave it out whenever the headline already " +
                "says the whole thing, which is the usual case: a reminder is " +
                "usually just its headline, and writing the same instruction " +
                "twice reads as a stutter.",
        );

    const setTimerTool = tool(
        async ({ label, message, minutes, seconds }, runtime: ToolRuntime) => {
            const access = guard(runtime, "setTimer");
            if (!access.ok) {
                return access.text;
            }
            const duration = timerDuration(minutes, seconds);
            if (!duration.ok) {
                return `The timer was not set: ${duration.reason}`;
            }
            const at = now();
            const runAt = new Date(at.getTime() + duration.ms);
            return scheduledText(
                { done: "Timer set", refused: "The timer was not set" },
                storeJob(access.userId, {
                    label,
                    class: "timer",
                    payload: {
                        kind: "message",
                        message: message ?? label,
                    },
                    runAt,
                    at,
                }),
                at,
            );
        },
        {
            name: "setTimer",
            description:
                "Sets a countdown timer for the user. Use it when they ask for " +
                "a timer — 'set a timer for ten minutes', 'timer for the " +
                "pasta', 'ten seconds' — and give the duration as `minutes` " +
                "for a minute or more, or `seconds` for anything shorter " +
                "(at most 1440 minutes, a day). Any length from one second " +
                "up is accepted. A timer is an interruption: it arrives even " +
                "during quiet hours, because that is what a countdown is " +
                "for. For a time of day ('at 8'), or for something that can " +
                "wait, use remindMe instead. `label` is the headline they " +
                "see when it fires; `message` is optional detail.",
            schema: z.object({
                label: labelSchema,
                message: messageSchema,
                minutes: z
                    .number()
                    .optional()
                    .describe(
                        "The duration in minutes, for a timer a minute or " +
                            "longer (10 = ten minutes). At most 1440. Give " +
                            "either `minutes` or `seconds`, not both.",
                    ),
                seconds: z
                    .number()
                    .optional()
                    .describe(
                        "The duration in seconds, for a timer under a minute " +
                            "(10 = ten seconds).",
                    ),
            }),
        },
    );

    const remindMeTool = tool(
        async (
            { label, message, at, onDate, inMinutes, ...cadence },
            runtime: ToolRuntime,
        ) => {
            const access = guard(runtime, "remindMe");
            if (!access.ok) {
                return access.text;
            }
            const atTime = now();
            const stated = statedCadence(cadence);
            const first = cadenceFirst(
                resolveWhen({ at, onDate, inMinutes }, atTime),
                stated,
                atTime,
            );
            if (!first.ok) {
                return `The reminder was not set: ${first.reason}`;
            }
            return scheduledText(
                {
                    done: "Reminder scheduled",
                    refused: "The reminder was not set",
                },
                storeJob(access.userId, {
                    label,
                    class: "reminder",
                    payload: {
                        kind: "message",
                        message: message ?? label,
                    },
                    runAt: first.at,
                    ...(stated !== null
                        ? { repeat: anchoredRule(stated, first.at) }
                        : {}),
                    at: atTime,
                }),
                atTime,
            );
        },
        {
            name: "remindMe",
            description:
                "Reminds the user of something at a time they choose. Quiet " +
                "by design: if the moment falls inside their quiet hours the " +
                "reminder waits until they end rather than waking them. Give " +
                "the time the way they said it — `at` as a 24-hour clock time " +
                "(a bare time means the next time the clock reads that), plus " +
                "`onDate` for a day ('tomorrow', a weekday, or a date like " +
                "2026-10-20), or `inMinutes` for a delay. If they did not say " +
                "when, or said 'later' or 'soon', ask — never guess a time. " +
                "Unless they asked for a repeat: a cadence is its own when " +
                "('every 30 minutes' starts half an hour from now, 'every " +
                "day' starts tomorrow at this time), so pass the cadence and " +
                "no time at all rather than asking. `label` is the headline " +
                "('Call Mum'); `message` is optional " +
                "detail. The result says when it will run; if it mentions " +
                "quiet hours, tell them when it will arrive instead of " +
                "promising it at the time they asked for.",
            schema: z.object({
                label: labelSchema,
                message: messageSchema,
                at: z
                    .string()
                    .optional()
                    .describe(
                        "A 24-hour clock time like 08:30. Without `onDate` it " +
                            "means the next time the clock reads that.",
                    ),
                onDate: z
                    .string()
                    .optional()
                    .describe(
                        "The day for `at`: 'today', 'tomorrow', a weekday name " +
                            "('friday', 'fri'), or a date like 2026-10-20.",
                    ),
                inMinutes: z
                    .number()
                    .optional()
                    .describe(
                        "A delay in minutes instead of a clock time, e.g. 20 " +
                            "for 'in twenty minutes'.",
                    ),
                ...cadenceFields(false),
                repeat: repeatSchema.optional(),
            }),
        },
    );

    const scheduleTaskTool = tool(
        async (
            {
                label,
                tool: toolName,
                args,
                at,
                onDate,
                inMinutes,
                gate,
                ...cadence
            },
            runtime: ToolRuntime,
        ) => {
            const access = guard(runtime, "scheduleTask");
            if (!access.ok) {
                return access.text;
            }
            const atTime = now();
            const resolved = resolveSchedulableTool(deps.tools, toolName);
            if (!resolved.ok) {
                return `The task was not scheduled: ${resolved.reason}.`;
            }
            const stated = statedCadence(cadence);
            const first = cadenceFirst(
                resolveWhen({ at, onDate, inMinutes }, atTime),
                stated,
                atTime,
            );
            if (!first.ok) {
                return `The task was not scheduled: ${first.reason}`;
            }
            const argumentProblem = argumentsProblem(resolved.tool, args);
            if (argumentProblem !== null) {
                return `The task was not scheduled: ${argumentProblem}`;
            }
            const gated = gateFor(gate);
            if (!gated.ok) {
                return `The task was not scheduled: ${gated.reason}`;
            }
            return scheduledText(
                {
                    done: "Task scheduled",
                    refused: "The task was not scheduled",
                },
                storeJob(access.userId, {
                    label,
                    class: "notification",
                    payload: {
                        kind: "tool",
                        toolName: resolved.tool.name,
                        toolArgs: args ?? {},
                    },
                    runAt: first.at,
                    ...(stated !== null
                        ? { repeat: anchoredRule(stated, first.at) }
                        : {}),
                    ...(gated.gate !== null ? { gate: gated.gate } : {}),
                    at: atTime,
                }),
                atTime,
            );
        },
        {
            name: "scheduleTask",
            description:
                "Schedules one of your tools to run later, on its own — 'turn " +
                "the porch lights on at seven', 'check the weather at eight'. " +
                "`tool` must be a tool you can call right now, and `args` must " +
                "be exactly the arguments it needs; anything else is refused " +
                "now, while the user is here, rather than failing later with " +
                "nobody watching. It arrives as a quiet notification, so if it " +
                "lands inside quiet hours the announcement waits. Give the time " +
                "as `at` (24-hour) with an optional `onDate`, or as " +
                "`inMinutes`. Use remindMe when the point is to tell the user " +
                "something rather than to do something: a scheduled task never " +
                "speaks for itself.",
            schema: z.object({
                label: labelSchema,
                tool: z
                    .string()
                    .trim()
                    .min(1)
                    .describe(
                        "The exact name of the tool to run later, e.g. " +
                            "homeAssistant.",
                    ),
                args: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe(
                        "The arguments for that tool, exactly as its own " +
                            "schema wants them. Omit for a tool that takes none.",
                    ),
                at: z
                    .string()
                    .optional()
                    .describe("A 24-hour clock time like 19:00."),
                onDate: z
                    .string()
                    .optional()
                    .describe(
                        "The day for `at`: 'today', 'tomorrow', a weekday name, " +
                            "or a date like 2026-10-20.",
                    ),
                inMinutes: z
                    .number()
                    .optional()
                    .describe("A delay in minutes instead of a clock time."),
                ...cadenceFields(false),
                repeat: repeatSchema.optional(),
                gate: gateSchema,
            }),
        },
    );

    const schedulePromptTool = tool(
        async (
            { label, prompt, at, onDate, inMinutes, gate, ...cadence },
            runtime: ToolRuntime,
        ) => {
            const access = guard(runtime, "schedulePrompt");
            if (!access.ok) {
                return access.text;
            }
            const atTime = now();
            const stated = statedCadence(cadence);
            const first = cadenceFirst(
                resolveWhen({ at, onDate, inMinutes }, atTime),
                stated,
                atTime,
            );
            if (!first.ok) {
                return `The job was not scheduled: ${first.reason}`;
            }
            const gated = gateFor(gate);
            if (!gated.ok) {
                return `The job was not scheduled: ${gated.reason}`;
            }
            return scheduledText(
                {
                    done: "Job scheduled",
                    refused: "The job was not scheduled",
                },
                storeJob(access.userId, {
                    label,
                    class: "notification",
                    payload: { kind: "prompt", prompt },
                    runAt: first.at,
                    ...(stated !== null
                        ? { repeat: anchoredRule(stated, first.at) }
                        : {}),
                    ...(gated.gate !== null ? { gate: gated.gate } : {}),
                    at: atTime,
                }),
                atTime,
            );
        },
        {
            name: "schedulePrompt",
            description:
                "Schedules a job for you to *do something* later — a prompt you " +
                "will run on your own, with the reply filed as a quiet " +
                "notification. Use it when the work is thinking or writing " +
                "rather than one tool call: 'every night, summarise my day', " +
                "'each morning at eight, brief me on the news', 'in an hour, " +
                "check whether the pasta recipe needs more salt'. For a single " +
                "tool call use scheduleTask; to tell the user something, use " +
                "remindMe. `prompt` is the instruction you will carry out, " +
                "written to stand on its own — nobody is there to answer a " +
                "question when it runs. Give the time as `at` (24-hour) with " +
                "an optional `onDate`, or as `inMinutes`, and use `repeat` for " +
                "a recurring job. `gate` makes a frequent schedule affordable: " +
                "'every five minutes, only if the front door opened' is a " +
                "prompt with a gate, and a firing whose check finds nothing " +
                "changed does not run or announce anything.",
            schema: z.object({
                label: labelSchema,
                prompt: z
                    .string()
                    .trim()
                    .min(1)
                    .describe(
                        "The instruction to carry out when it runs, written " +
                            "for you to read later with no conversation " +
                            "around it.",
                    ),
                at: z
                    .string()
                    .optional()
                    .describe("A 24-hour clock time like 07:30."),
                onDate: z
                    .string()
                    .optional()
                    .describe(
                        "The day for `at`: 'today', 'tomorrow', a weekday " +
                            "name, or a date like 2026-10-20.",
                    ),
                inMinutes: z
                    .number()
                    .optional()
                    .describe("A delay in minutes instead of a clock time."),
                ...cadenceFields(false),
                repeat: repeatSchema.optional(),
                gate: gateSchema,
            }),
        },
    );

    const listJobsTool = tool(
        async (_args, runtime: ToolRuntime) => {
            const access = guard(runtime, "listJobs");
            if (!access.ok) {
                return access.text;
            }
            const at = now();
            const jobs = deps.ledger.listJobs(access.userId, {
                limit: LIST_LIMIT,
            });
            if (jobs.length === 0) {
                return "No jobs are scheduled.";
            }
            const lines = jobs.map((job) => formatJobLine(job, at));
            return `${jobs.length === 1 ? "1 scheduled job" : `${jobs.length} scheduled jobs`}:\n${lines.join("\n")}`;
        },
        {
            name: "listJobs",
            description:
                "Lists the jobs the user has scheduled and that have not yet " +
                "settled, with the id and the time of each. Call it before " +
                "cancelJob or snoozeReminder to get the exact id, and whenever " +
                "the user asks what is scheduled. It does not show jobs that " +
                "already ran — those are in their notification list.",
            schema: z.object({}),
        },
    );

    const cancelJobTool = tool(
        async ({ id }, runtime: ToolRuntime) => {
            const access = guard(runtime, "cancelJob");
            if (!access.ok) {
                return access.text;
            }
            const at = now();
            const job = deps.ledger.getJob(access.userId, id);
            if (job === null) {
                return `There is no job with the id "${id}". Call listJobs to get the exact id.`;
            }
            if (job.state !== "pending") {
                // The row was already settled when it was read: cancel is
                // idempotent at the store, so the honest answer comes from the
                // state we saw rather than from a successful-looking re-read.
                return `"${job.label}" is already ${job.state} — there is nothing to cancel.`;
            }
            const cancelled = deps.ledger.cancelJob(access.userId, id);
            if (cancelled === null || cancelled.state !== "cancelled") {
                // It became running (or settled) between the read and the
                // claim — losing the race is still a refusal to report.
                return `"${job.label}" is ${cancelled?.state ?? job.state} now — it cannot be cancelled.`;
            }
            logger.info(`job ${job.id} cancelled at the user's request`);
            return `Cancelled "${cancelled.label}" (${cancelled.id}), which was due ${formatLocal(new Date(cancelled.runAt), at)}.`;
        },
        {
            name: "cancelJob",
            description:
                "Cancels one of the user's scheduled jobs by its exact id. Call " +
                "listJobs first if you do not have the id — never guess one, " +
                "and never cancel a job you have not just listed. Only a job " +
                "that has not started can be cancelled; one already running or " +
                "finished cannot, and the result says so.",
            schema: z.object({
                id: z
                    .string()
                    .trim()
                    .min(1)
                    .describe("The job id from listJobs, e.g. 3f9a2c1b."),
            }),
        },
    );

    const snoozeReminderTool = tool(
        async ({ id, minutes }, runtime: ToolRuntime) => {
            const access = guard(runtime, "snoozeReminder");
            if (!access.ok) {
                return access.text;
            }
            const at = now();
            const result = creator.snooze(access.userId, id, minutes);
            if (!result.ok) {
                switch (result.code) {
                    case "missing":
                        return `There is no job with the id "${id}". Call listJobs to get the exact id.`;
                    case "not-a-reminder":
                        return `"${result.job?.label}" is a ${result.job?.class}, not a reminder — only a reminder can be snoozed. A timer is a countdown and a notification is already filed; use cancelJob or remindMe instead.`;
                    case "cancelled":
                        return `${result.reason} Set a new reminder with remindMe instead.`;
                    case "running":
                        // A claimed job is mid-run; re-creating it would tell
                        // the user twice for one moment.
                        return `${result.reason} Let it finish. Use remindMe if you need another reminder after it.`;
                    case "cannot-move":
                        return `${result.reason} Use remindMe for a new reminder.`;
                    case "not-repeatable":
                        return `${result.reason} Use remindMe or scheduleTask instead.`;
                    default:
                        // `invalid-minutes`, and any creation bound the
                        // re-created reminder hit.
                        return `The reminder was not snoozed: ${result.reason}`;
                }
            }
            if (result.action === "moved") {
                return `Snoozed "${result.job.label}" (${result.job.id}) to ${formatLocal(result.runAt, at)}, ${formatRelative(result.runAt, at)}.${result.note}`;
            }
            return `"${result.job.label}" was due ${formatLocal(result.previousRunAt ?? new Date(result.job.runAt), at)} — set another reminder (job ${result.job.id}) for ${formatLocal(result.runAt, at)}, ${formatRelative(result.runAt, at)}.${result.note}`;
        },
        {
            name: "snoozeReminder",
            description:
                "Snoozes a reminder: 'snooze that', 'remind me again in an " +
                "hour', 'later'. Pass the job id from listJobs and `minutes` " +
                "from now. A reminder that has not fired yet is moved; one " +
                "that already ran is set again for the new time with the same " +
                "text, and the result says which happened. Only a reminder " +
                "can be snoozed — a timer is a countdown and a notification " +
                "is already filed, so use cancelJob or remindMe for those. " +
                "The result also says whether quiet hours will hold it.",
            schema: z.object({
                id: z
                    .string()
                    .trim()
                    .min(1)
                    .describe("The reminder's job id from listJobs."),
                minutes: z
                    .number()
                    .describe(
                        "How long from now to snooze it, in minutes (at most " +
                            "a week, 10080).",
                    ),
            }),
        },
    );

    return [
        setTimerTool,
        remindMeTool,
        scheduleTaskTool,
        schedulePromptTool,
        listJobsTool,
        cancelJobTool,
        snoozeReminderTool,
    ];
}

/**
 * The length a timer request asks for, or why it is not a timer.
 *
 * `seconds` exists because "set a timer for ten seconds" is ordinary and the
 * first version refused it; `minutes` stays the natural unit for anything a
 * minute or longer. Asking for both at once is refused rather than summed,
 * because a model that filled in both is guessing at the unit.
 */
function timerDuration(
    minutes: number | undefined,
    seconds: number | undefined,
): { ok: true; ms: number } | { ok: false; reason: string } {
    if (minutes === undefined && seconds === undefined) {
        return {
            ok: false,
            reason: "give `minutes`, or `seconds` for a countdown under a minute.",
        };
    }
    if (minutes !== undefined && seconds !== undefined) {
        return {
            ok: false,
            reason: "give either `minutes` or `seconds`, not both.",
        };
    }
    const ms = (minutes ?? 0) * 60_000 + (seconds ?? 0) * 1_000;
    if (!Number.isFinite(ms) || ms < MIN_DURATION_SECONDS * 1_000) {
        return {
            ok: false,
            reason: `a timer must be at least ${MIN_DURATION_SECONDS} second long.`,
        };
    }
    if (ms > MAX_DURATION_MINUTES * 60_000) {
        return {
            ok: false,
            reason: `a countdown longer than ${MAX_DURATION_MINUTES} minutes (a day) is a reminder — use remindMe.`,
        };
    }
    return { ok: true, ms };
}

/**
 * A creation call's description of the stored job, for the model's reply.
 *
 * Pure and exported for tests: `"Call Mum" (job 3f9a2c1b) — tomorrow at 8:00 AM,
 * in 13 hours`. A tool job adds what it will run, because "Porch lights on" at
 * 7pm means nothing without "runs homeAssistant".
 */
export function describeJob(job: AppJob, now: Date): string {
    const at = new Date(job.runAt);
    const payload =
        job.kind === "tool" && job.toolName !== null
            ? ` (runs ${job.toolName})`
            : job.kind === "prompt"
              ? " (runs a prompt)"
              : "";
    return `"${job.label}" (job ${job.id}) — ${formatLocal(at, now)}, ${formatRelative(at, now)}${payload}${repeatPhrase(job)}${gatePhrase(job)}`;
}

/**
 * The cadence clause on a job's line (#90 phase 8d), or `""` for a one-shot.
 *
 * The words come from the protocol's `describeRepeat`, so the sentence the model
 * says when it sets a schedule is the sentence it reads back later — and the
 * same words the page shows. An unreadable stored rule adds nothing rather than
 * throwing: the runner warns about that case, and a tool that failed to *list* a
 * job because its rule was corrupt would be worse than one that omits it.
 */
function repeatPhrase(job: AppJob): string {
    if (job.repeat === null || job.repeat === undefined) {
        return "";
    }
    const parsed = parseJobRepeat(job.repeat);
    return parsed.ok ? `, repeating ${describeRepeat(parsed.repeat)}` : "";
}

/**
 * The conditional clause on a job's line (#90 phases 8f, 8g), or `""`.
 *
 * Said in the model's own words rather than as "gated": the point of reading a
 * job back is that the user can hear that it *may not fire*, and "but only when
 * homeAssistant changes" is the sentence that says so. A stored gate that no
 * longer parses adds nothing, for the same reason `repeatPhrase` omits a rule the
 * runner would warn about.
 */
function gatePhrase(job: AppJob): string {
    if (job.gate === null || job.gate === undefined) {
        return "";
    }
    const parsed = parseJobGate(job.gate);
    return parsed.ok ? `, but only when ${parsed.gate.tool} changes` : "";
}

/** One `listJobs` line: id, class, label, local time, relative time, payload. */
export function formatJobLine(job: AppJob, now: Date): string {
    const at = new Date(job.runAt);
    return `- ${job.id} (${job.class}) "${job.label}" — ${formatLocal(at, now)}, ${formatRelative(at, now)}${repeatPhrase(job)}${gatePhrase(job)}`;
}

/**
 * A moment as the user would say it: `today at 8:00 PM`, `tomorrow at 8:00 AM`,
 * or `Friday 2026-10-23 at 8:00 AM` further out.
 *
 * Local days are compared by calendar date (via local midnights), so the answer
 * is right across a DST change in the same way the resolver is.
 */
export function formatLocal(at: Date, now: Date): string {
    return `${localDay(at, now)} at ${format12Hour(at.getHours(), at.getMinutes())}`;
}

/**
 * How far away a moment is, rounded to the unit a person would use: `in 10
 * minutes`, `in 13 hours`, `in 3 days` (and `just now` for a moment that has
 * only just passed).
 */
export function formatRelative(at: Date, now: Date): string {
    const deltaMs = at.getTime() - now.getTime();
    const future = deltaMs >= 0;
    // Floored, so half a minute is still "under a minute" rather than a minute
    // that has not happened yet.
    const minutes = Math.floor(Math.abs(deltaMs) / 60_000);
    if (minutes < 1) {
        return future ? "in under a minute" : "just now";
    }
    const hours = Math.round(minutes / 60);
    const days = Math.round(hours / 24);
    if (minutes < 60) {
        return `${future ? "in " : ""}${plural(minutes, "minute")}${future ? "" : " ago"}`;
    }
    if (hours < 36) {
        return `${future ? "in " : ""}${plural(hours, "hour")}${future ? "" : " ago"}`;
    }
    return `${future ? "in " : ""}${plural(days, "day")}${future ? "" : " ago"}`;
}

/** `1 minute` / `2 minutes` — the only pluralisation this file needs. */
function plural(count: number, unit: string): string {
    return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** `today` / `tomorrow` / `yesterday` / `Friday 2026-10-23`. */
function localDay(at: Date, now: Date): string {
    const days = Math.round(
        (new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() -
            new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate(),
            ).getTime()) /
            86_400_000,
    );
    if (days === 0) {
        return "today";
    }
    if (days === 1) {
        return "tomorrow";
    }
    if (days === -1) {
        return "yesterday";
    }
    const pad = (n: number) => String(n).padStart(2, "0");
    const weekday = WEEKDAYS[at.getDay()];
    return `${weekday} ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Full weekday names, indexed as `Date.getDay()` indexes them. */
const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/**
 * Why `args` would not satisfy `tool`'s own schema, or `null` when it would.
 *
 * Scheduling a call that the tool will reject is exactly the failure this phase
 * exists to move earlier — at 7am nobody can answer "it needs an entity_id". The
 * schema is read structurally because LangChain's tool interface permits a JSON
 * schema as well as zod; when it is not introspectable, the call is allowed and
 * the runner's own validation becomes the gate.
 */
function argumentsProblem(
    tool: StructuredToolInterface,
    args: Record<string, unknown> | undefined,
): string | null {
    const candidate = args ?? {};
    const schema = tool.schema as unknown as {
        safeParse?: (value: unknown) => {
            success: boolean;
            error?: {
                issues: { path: (string | number)[]; message: string }[];
            };
        };
    };
    if (typeof schema.safeParse !== "function") {
        return null;
    }
    const parsed = schema.safeParse(candidate);
    if (parsed.success) {
        return null;
    }
    const issue = parsed.error?.issues[0];
    const where = issue?.path.join(".") ?? "(arguments)";
    return `the ${tool.name} tool needs different arguments — ${where}: ${issue?.message ?? "invalid"}.`;
}
