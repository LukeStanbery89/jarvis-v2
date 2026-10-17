/**
 * The scheduling tools (#90 phase 3): the model's way to create, inspect and
 * cancel fire-at-T jobs.
 *
 * Five tools, and their split is the invariant. **The class comes from which
 * tool was called, never from an argument.** `setTimer` always stores `timer`
 * (it interrupts, even in quiet hours), `remindMe` always stores `reminder` (it
 * waits out the window), and `scheduleTask` always stores `notification` (it is
 * filed, not announced). No tool exposes `class` or `priority`, because either
 * would be a way for the model to choose how loudly the user is interrupted —
 * the exact reach the notification design removed from `priority` (#139/#90).
 *
 * The rest of the policy stays where it already lives:
 *
 * - **When** is resolved by `scheduler/time.ts` — the model supplies the words
 *   ("08:30", "tomorrow", "in 10 minutes"), never a timestamp. The resolver owns
 *   next-occurrence, past-date and weekday rules, and its zone is the server's
 *   local clock, the same one `getCurrentTime` reports.
 * - **Whether a tool may be scheduled** is `scheduler/tools.ts`: creation goes
 *   through the same allowlist the runner enforces, plus that tool's own zod
 *   schema, so an impossible task is refused *now*, while the user is still
 *   here, instead of failing silently at 7am.
 * - **What the user is told** is the announcement the runner makes, with the
 *   job's class. This file only predicts what will happen to it (quiet hours as
 *   they stand) and says so; it never pre-defers, because the runner owns that
 *   decision and reads the prefs live at fire time.
 *
 * Every refusal is a returned string in the model's voice, never a throw, so a
 * refused request degrades into something it can relay or correct.
 */
import { randomBytes } from "node:crypto";
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import {
    MAX_NOTIFICATION_BODY_LENGTH,
    MAX_NOTIFICATION_TITLE_LENGTH,
} from "@lukestanbery/jarvis-protocol";
import { logger } from "../../logger";
import { requireSignedInUser } from "./metering";
import { resolveSchedulableTool } from "../../scheduler/tools";
import { resolveWhen } from "../../scheduler/time";
import {
    NOTIFY_ENABLED_PREF,
    NOTIFY_QUIET_HOURS_PREF,
    parseQuietHours,
    quietHoursEnd,
    quietHoursHold,
} from "../../notify/prefs";
import { format12Hour } from "./clock";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AppJob, JobLedger } from "@lukestanbery/jarvis-auth";
import type { NotificationClass } from "@lukestanbery/jarvis-protocol";

/** Everything the scheduling tools need, injected at wiring time. */
export interface JobsToolDeps {
    /**
     * The job ledger this tool creates into, plus the prefs read the quiet-hours
     * prediction needs. `AppDatabase` satisfies both halves; tests pass the same
     * store (structural, so a fake can be narrower).
     */
    ledger: JobLedger & { getPrefs(userId: number): Record<string, unknown> };
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

/**
 * The shortest timer a user can set: one second.
 *
 * The floor is what the clock can express rather than what felt sensible —
 * "set a timer for ten seconds" is an ordinary thing to ask, and the first
 * live run turned it into a refusal. The scheduler's tick is five seconds, so
 * anything at or above a second lands; the tick may add a few.
 */
export const MIN_DURATION_SECONDS = 1;

/**
 * The longest timer a user can set: a day.
 *
 * Beyond that a countdown is not what was asked for — a moment tomorrow is a
 * reminder — and the `timer` class pierces quiet hours, so a week-long "timer"
 * would be a way to keep breaching them.
 */
export const MAX_DURATION_MINUTES = 1440;

/** How many pending jobs `listJobs` renders at once. */
export const LIST_LIMIT = 20;

/** Bytes of randomness in a job id (eight lower-case hex characters). */
const NEW_ID_BYTES = 4;

/** The payload a creation call stores; the table's CHECK admits exactly one. */
type JobPayload =
    | { kind: "message"; message: string }
    | { kind: "tool"; toolName: string; toolArgs: Record<string, unknown> };

/** A creation attempt: the stored job and its prediction, or why it failed. */
type ScheduleOutcome =
    { ok: true; job: AppJob; note: string } | { ok: false; reason: string };

/**
 * Builds the five scheduling tools over the injected ledger.
 *
 * Registered only when the scheduler is running (`JARVIS_SCHEDULER` not off and
 * notifications wired): a job nobody can run is a promise the server cannot
 * keep, and a tool that made one would be worse than no tool at all.
 */
export function createJobsTools(deps: JobsToolDeps): StructuredToolInterface[] {
    const now = deps.now ?? (() => new Date());
    const newId =
        deps.newId ?? (() => randomBytes(NEW_ID_BYTES).toString("hex"));

    /**
     * Stores a job, applying the three bounds that keep the queue meaningful: a
     * label/message that the announcement can carry, a moment within the
     * horizon, and room under the per-user cap.
     *
     * The cap is about **pending** rows (the ledger's default listing), because
     * that is the work still owed; settled rows are history and the runner's
     * retention prune evicts them first, so a job accepted here can never be the
     * row the prune eats.
     */
    function storeJob(
        userId: number,
        request: {
            label: string;
            class: NotificationClass;
            payload: JobPayload;
            runAt: Date;
            at: Date;
        },
    ): ScheduleOutcome {
        const { label, payload, runAt, at } = request;
        if (label.length > MAX_NOTIFICATION_TITLE_LENGTH) {
            return {
                ok: false,
                reason: `\`label\` must be at most ${MAX_NOTIFICATION_TITLE_LENGTH} characters — shorten it and try again.`,
            };
        }
        if (
            payload.kind === "message" &&
            payload.message.length > MAX_NOTIFICATION_BODY_LENGTH
        ) {
            return {
                ok: false,
                reason: `\`message\` must be at most ${MAX_NOTIFICATION_BODY_LENGTH} characters — shorten it and try again.`,
            };
        }
        if (runAt.getTime() - at.getTime() > deps.maxHorizonMs) {
            const days = Math.floor(deps.maxHorizonMs / 86_400_000);
            return {
                ok: false,
                reason: `that is more than ${days} days ahead, further than this server schedules.`,
            };
        }
        const pending = deps.ledger.listJobs(userId, {
            limit: deps.maxPerUser + 1,
        }).length;
        if (pending >= deps.maxPerUser) {
            return {
                ok: false,
                reason: `the user already has ${deps.maxPerUser} jobs scheduled, which is the limit — cancel one with cancelJob first.`,
            };
        }
        let job: AppJob;
        try {
            job = deps.ledger.createJob(userId, {
                id: newId(),
                createdAt: at.toISOString(),
                label,
                class: request.class,
                kind: payload.kind,
                ...(payload.kind === "message"
                    ? { message: payload.message }
                    : {
                          toolName: payload.toolName,
                          toolArgs: payload.toolArgs,
                      }),
                runAt: runAt.toISOString(),
            });
        } catch (err) {
            logger.warn(
                `scheduling a job failed — ${err instanceof Error ? err.message : "unexpected error"}`,
            );
            return {
                ok: false,
                reason: "the job could not be stored. Tell the user it was not scheduled.",
            };
        }
        logger.info(
            `job ${job.id} scheduled (${job.class}, ${job.kind}): "${job.label}" → ${job.runAt}`,
        );
        return { ok: true, job, note: quietNote(userId, job.class, runAt) };
    }

    /**
     * What quiet hours, as they stand, will do to this job's announcement.
     *
     * A prediction, not a promise: the runner reads the prefs live at fire time,
     * so the user can change them in between. Saying it now is what stops the
     * model promising an interruption that quiet hours will hold — and the read
     * is defensive, because a failed prefs read must never undo a job that was
     * already stored (the note is a courtesy; the row is the fact).
     */
    function quietNote(
        userId: number,
        jobClass: NotificationClass,
        runAt: Date,
    ): string {
        let prefs: Record<string, unknown>;
        try {
            prefs = deps.ledger.getPrefs(userId);
        } catch (err) {
            logger.warn(
                `could not read notification prefs for a quiet-hours prediction — ${err instanceof Error ? err.message : "unexpected error"}`,
            );
            return "";
        }
        if (prefs[NOTIFY_ENABLED_PREF] === false) {
            return " Notifications are switched off for this account, so it will be recorded but not pushed — as things stand.";
        }
        if (!quietHoursHold(prefs, jobClass, runAt)) {
            return "";
        }
        const window = parseQuietHours(prefs[NOTIFY_QUIET_HOURS_PREF]);
        if (window === null) {
            return "";
        }
        const span = `${clockText(window.start)}–${clockText(window.end)}`;
        const end = quietHoursEnd(window, runAt);
        const endText = format12Hour(end.getHours(), end.getMinutes());
        switch (jobClass) {
            case "reminder":
                return ` It falls inside quiet hours (${span}) as things stand, so it will wait until ${endText} and be announced then.`;
            case "notification":
                return ` That is inside quiet hours (${span}) as things stand, so it will be recorded and wait until ${endText} instead of interrupting.`;
            case "timer":
                // Unreachable: a timer pierces quiet hours by design, which is
                // why `quietHoursHold` answers false for it.
                return "";
        }
    }

    /** Creation guard shared by the three creating tools. */
    function guard(runtime: ToolRuntime, logName: string) {
        return requireSignedInUser(runtime, {
            subject: "Scheduling",
            logName,
        });
    }

    /** "Reminder scheduled: …" once `storeJob` succeeded. */
    function scheduledText(
        verb: string,
        outcome: ScheduleOutcome,
        at: Date,
    ): string {
        if (!outcome.ok) {
            return `${verb} failed: ${outcome.reason}`;
        }
        return `${verb}: ${describeJob(outcome.job, at)}.${outcome.note}`;
    }

    const labelSchema = z
        .string()
        .trim()
        .min(1)
        .describe(
            "The headline the user will see, written to stand on its own " +
                "('Call Mum', 'Pasta', 'Porch lights on').",
        );

    const messageSchema = z
        .string()
        .trim()
        .optional()
        .describe(
            "Optional detail delivered under the headline. Leave it out " +
                "when the headline says enough.",
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
                "Timer set",
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
            { label, message, at, onDate, inMinutes },
            runtime: ToolRuntime,
        ) => {
            const access = guard(runtime, "remindMe");
            if (!access.ok) {
                return access.text;
            }
            const atTime = now();
            const when = resolveWhen({ at, onDate, inMinutes }, atTime);
            if (!when.ok) {
                return `The reminder was not set: ${when.reason}`;
            }
            return scheduledText(
                "Reminder scheduled",
                storeJob(access.userId, {
                    label,
                    class: "reminder",
                    payload: {
                        kind: "message",
                        message: message ?? label,
                    },
                    runAt: when.at,
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
                "`label` is the headline ('Call Mum'); `message` is optional " +
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
            }),
        },
    );

    const scheduleTaskTool = tool(
        async (
            { label, tool: toolName, args, at, onDate, inMinutes },
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
            const when = resolveWhen({ at, onDate, inMinutes }, atTime);
            if (!when.ok) {
                return `The task was not scheduled: ${when.reason}`;
            }
            const argumentProblem = argumentsProblem(resolved.tool, args);
            if (argumentProblem !== null) {
                return `The task was not scheduled: ${argumentProblem}`;
            }
            return scheduledText(
                "Task scheduled",
                storeJob(access.userId, {
                    label,
                    class: "notification",
                    payload: {
                        kind: "tool",
                        toolName: resolved.tool.name,
                        toolArgs: args ?? {},
                    },
                    runAt: when.at,
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

    return [
        setTimerTool,
        remindMeTool,
        scheduleTaskTool,
        listJobsTool,
        cancelJobTool,
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
            : "";
    return `"${job.label}" (job ${job.id}) — ${formatLocal(at, now)}, ${formatRelative(at, now)}${payload}`;
}

/** One `listJobs` line: id, class, label, local time, relative time, payload. */
export function formatJobLine(job: AppJob, now: Date): string {
    const at = new Date(job.runAt);
    return `- ${job.id} (${job.class}) "${job.label}" — ${formatLocal(at, now)}, ${formatRelative(at, now)}`;
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

/** `"07:30"` → `"7:30 AM"`; only called on a parsed quiet-hours window. */
function clockText(value: string): string {
    const [hours, minutes] = value.split(":").map(Number);
    return format12Hour(hours, minutes);
}

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
