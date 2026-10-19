/**
 * The one creation policy for scheduled jobs (#90 phase 5).
 *
 * Jobs are created through two doors — the model's tools
 * (`llm/tools/jobs.ts`) and the REST surface a page uses
 * (`scheduler/http.ts`) — and both have to answer the same questions the same
 * way: what a label, a message or a prompt may be, how far ahead a job may be
 * set, how many may be pending at once, whether a schedule is too frequent to
 * keep, what a gate may read, what quiet hours will do to the announcement, and
 * what an edit or a snooze is allowed to touch. Those answers live here,
 * once. Each surface renders them for its own reader (the tools in the model's
 * voice, the router as JSON), but neither decides them.
 *
 * **The class is the caller's.** A tool owns its job's class (`setTimer` is
 * always a timer, `remindMe` always a reminder), and the REST create takes it
 * from the request, because a page is the user's own hand. What no surface
 * accepts is a class *from the model*: the class decides whether quiet hours
 * may hold an announcement back, so a model that could name one could pierce
 * them. That is the same reach #139 took away from `priority`.
 *
 * Times arrive here as instants. The natural-language half — "at 8",
 * "tomorrow", "in ten minutes" — is the model's interface and belongs to
 * `scheduler/time.ts`; a page has a date picker and sends what it produced.
 *
 * Every refusal is a value (`{ ok: false, code, reason }`), never a throw: the
 * `code` is the decision a surface routes on and the `reason` is a sentence for
 * the model to relay, so neither has to re-derive the other's wording.
 */
import { randomBytes } from "node:crypto";
import {
    MAX_NOTIFICATION_BODY_LENGTH,
    MAX_NOTIFICATION_TITLE_LENGTH,
} from "@lukestanbery/jarvis-protocol";
import {
    nextOccurrence,
    parseJobGate,
    parseJobRepeat,
} from "@lukestanbery/jarvis-protocol";
import type {
    JobGate,
    JobRepeat,
    NotificationClass,
} from "@lukestanbery/jarvis-protocol";
import type {
    AppJob,
    JobLedger,
    NotificationLedger,
} from "@lukestanbery/jarvis-auth";
import { logger } from "../logger";
import { format12Hour } from "../llm/tools/clock";
import { gateRefusal } from "./tools";
import {
    NOTIFY_ENABLED_PREF,
    NOTIFY_QUIET_HOURS_PREF,
    parseQuietHours,
    quietHoursEnd,
    quietHoursHold,
} from "../notify/prefs";

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

/**
 * The short end of a snooze: half a minute.
 *
 * A timer may be ten seconds because that is what the user asked the clock
 * for; a *snooze* is a human-scale "not now", and nothing useful is five
 * seconds long.
 */
export const MIN_SNOOZE_MINUTES = 0.5;

/**
 * The shortest gap between two firings an **ungated** schedule may ask for (#90
 * phases 8d, 8g).
 *
 * A `message` job's firing **is** its announcement, so its cadence is a
 * notification rate: fifteen minutes caps an announcing series at 96 rows a day,
 * which is already loud. A `tool` or `prompt` job has the same floor while every
 * firing is a model call or a device write, and the day's budget is the only
 * other thing between the user and a mistake.
 */
export const MIN_REPEAT_MINUTES = 15;

/**
 * The shortest gap a **gated** schedule may ask for (#90 phase 8g).
 *
 * A gate makes a frequent schedule affordable by declining the firings that have
 * nothing to do, and a declined firing announces nothing — so the notification
 * rate that sets {@link MIN_REPEAT_MINUTES} no longer applies, and what is left
 * is the scheduler's own resolution. One minute is the fastest a job can usefully
 * poll: the loop's tick is coarse, and anything faster would be a spin rather
 * than a schedule.
 *
 * This is why the gate exists: "every five minutes, but only if the door opened"
 * is the shape that makes a minutely job defensible, and it is the only schedule
 * allowed below the ungated floor.
 */
export const MIN_GATED_REPEAT_MINUTES = 1;

/**
 * The long end of a snooze: a week (#90 phase 7 fix).
 *
 * The classification table's three offsets are +60m, +24h and **+7d**, so a week
 * is the longest "not now" the product offers. The bound used to be
 * `MAX_DURATION_MINUTES` — the *timer's* day ceiling, which is about how long a
 * countdown may be for a different reason — and that made the menu's own "next
 * week" preset a refusal the first time anyone pressed it. A separate constant so
 * the two bounds cannot drift back into each other.
 */
export const MAX_SNOOZE_MINUTES = 7 * 24 * 60;

/** Bytes of randomness in a job id (eight lower-case hex characters). */
const NEW_ID_BYTES = 4;

/** Everything the creation policy needs, injected at wiring time. */
export interface JobCreatorDeps {
    /**
     * The job ledger this policy writes through, plus the prefs read the
     * quiet-hours prediction needs and the notification settling a snooze does
     * (#90 phase 6c). Named as a `Pick` of the notification ledger rather than
     * restated, so the seam is the auth package's and cannot drift from it;
     * `AppDatabase` satisfies all three, and tests pass the same store
     * (structural, so a fake can be narrower).
     */
    ledger: JobLedger &
        Pick<
            NotificationLedger,
            "listNotificationsForJob" | "setNotificationState"
        > & {
            getPrefs(userId: number): Record<string, unknown>;
        };
    /** How many jobs one account may have pending (`JARVIS_JOB_MAX_PER_USER`). */
    maxPerUser: number;
    /** How far ahead a job may be set (`JARVIS_JOB_MAX_HORIZON_DAYS`). */
    maxHorizonMs: number;
    /** Reads "now"; injectable so tests need no clock control. */
    now?: () => Date;
    /** Generates job ids; injectable so tests can assert them. */
    newId?: () => string;
}

/**
 * The payload a creation call stores.
 *
 * The table's CHECK admits exactly one of these per row. All three are reachable
 * since 8g: the tools schedule messages (`setTimer`/`remindMe`) and tools
 * (`scheduleTask`), the prompt tool schedules a turn (`schedulePrompt`), and the
 * REST surface stays message-only by decision — a page writes text, and anything
 * that spends the model is asked for in the conversation.
 */
export type JobPayload =
    | { kind: "message"; message: string }
    | { kind: "tool"; toolName: string; toolArgs: Record<string, unknown> }
    | { kind: "prompt"; prompt: string };

/** What a caller asks for; identity and `created_at` are the store's. */
export interface CreateRequest {
    label: string;
    class: NotificationClass;
    payload: JobPayload;
    /** The moment the job is owed at — for a **one-shot**. */
    runAt: Date;
    /**
     * The recurrence rule, when the job repeats (#90 phase 8d). Untrusted: this
     * is the door, so it is parsed here whatever the caller already did.
     */
    repeat?: unknown;
    /**
     * The check a firing must pass before its payload runs (#90 phase 8f/8g),
     * or omitted for a job that runs unconditionally. Untrusted for the same
     * reason as `repeat`, and validated against the same read-action allowlist
     * the runner enforces — a gate this policy stores is one the runner can make.
     */
    gate?: unknown;
    /**
     * The instant the request is being made, shared with `runAt`'s own
     * arithmetic so a job cannot be stamped a moment it never had. Defaults to
     * `now()`.
     */
    at?: Date;
}

/** Why a creation was refused — the decision, for a surface to route on. */
export type CreateRefusal =
    | "label-too-long"
    | "message-too-long"
    | "prompt-empty"
    | "prompt-too-long"
    | "invalid-gate"
    | "in-the-past"
    | "beyond-horizon"
    | "too-many"
    | "timer-too-long"
    /**
     * The rule is not one this server will keep (#90 phase 8d) — malformed, on
     * a class that cannot repeat, or too frequent. One code for three faults
     * because the *reason* is what every surface shows and it already says
     * which: a surface routes on the code only to pick a status, and all three
     * are the request's own fault.
     */
    | "invalid-repeat"
    | "store-failed";

/** A creation attempt: the stored job and its forecast, or why it failed. */
export type CreateOutcome =
    | { ok: true; job: AppJob; note: string }
    | { ok: false; code: CreateRefusal; reason: string };

/**
 * What quiet hours, as they stand, will do to a job's announcement.
 *
 * A prediction, never a promise: the runner reads the prefs live at fire time,
 * so the user can change them in between. `held` carries the instant the
 * announcement comes back — for a reminder, the moment it will *run* instead.
 */
export type QuietForecast =
    | { state: "clear" }
    | { state: "disabled" }
    | {
          state: "held";
          class: "reminder" | "notification";
          until: Date;
          /** The window as the user reads it, e.g. `22:00–07:00`. */
          window: string;
      };

/** Why an edit was refused. */
export type EditRefusal =
    | "missing"
    | "not-pending"
    | "not-a-message"
    /** A bound the edited field hit; the code is that creation bound. */
    | CreateRefusal;

/** An edit attempt: the row after it, or why nothing changed. */
export type EditOutcome =
    | { ok: true; job: AppJob }
    | {
          ok: false;
          code: EditRefusal;
          reason: string;
          /** The row as it stands, when it exists — for a caller to describe. */
          job: AppJob | null;
      };

/** Why a snooze was refused. */
export type SnoozeRefusal =
    | "missing"
    | "not-a-reminder"
    | "invalid-minutes"
    | "cancelled"
    | "running"
    | "cannot-move"
    | "not-repeatable"
    /** The re-created reminder hit a creation bound; the code is that bound. */
    | CreateRefusal;

/**
 * A snooze attempt.
 *
 * `moved` is a reminder that had not fired: its own `run_at` moved, no attempt
 * counted, nothing announced. `recreated` is one that already had its moment —
 * a fresh reminder with the same payload, which is why the new job comes back
 * with `previousRunAt` for the caller to explain.
 */
export type SnoozeOutcome =
    | {
          ok: true;
          action: "moved" | "recreated";
          job: AppJob;
          runAt: Date;
          previousRunAt: Date | null;
          note: string;
      }
    | { ok: false; code: SnoozeRefusal; reason: string; job: AppJob | null };

/**
 * The creation policy, as the two surfaces use it.
 *
 * Callers: `llm/tools/jobs.ts` (the model's tools, which render `reason` in the
 * model's voice) and `scheduler/http.ts` (the REST routes, which route on
 * `code` and answer JSON).
 */
export interface JobCreator {
    /** Stores a job, applying every bound this module owns. */
    create(userId: number, request: CreateRequest): CreateOutcome;
    /** What quiet hours will do to an announcement at `runAt`. */
    forecast(
        userId: number,
        jobClass: NotificationClass,
        runAt: Date,
    ): QuietForecast;
    /**
     * Edits a pending job's label, message, moment or schedule (#90 phase 8d).
     *
     * `repeat` is the rule to write, `null` to stop repeating, or absent to
     * leave it: setting or replacing one re-anchors the series at the edit and
     * decides the moment itself, while clearing one leaves the job due where it
     * stands.
     */
    edit(
        userId: number,
        id: string,
        patch: {
            label?: string;
            message?: string;
            runAt?: Date;
            repeat?: unknown | null;
        },
    ): EditOutcome;
    /** Snoozes a reminder: moves it, or sets it again for the new moment. */
    snooze(userId: number, id: string, minutes: number): SnoozeOutcome;
}

/**
 * Builds the creation policy over the injected ledger.
 *
 * One instance per process is enough; the tools and the router can share it,
 * and either can pass its own `now`/`newId` for tests.
 */
export function createJobCreator(deps: JobCreatorDeps): JobCreator {
    const now = deps.now ?? (() => new Date());
    const newId =
        deps.newId ?? (() => randomBytes(NEW_ID_BYTES).toString("hex"));

    /**
     * The bounds a label must satisfy, or `null` when it is fine.
     *
     * Shared by creation and edit so a label that cannot be created cannot be
     * edited into existence either.
     */
    function labelProblem(label: string): CreateRefusal | null {
        return label.length > MAX_NOTIFICATION_TITLE_LENGTH
            ? "label-too-long"
            : null;
    }

    /** The bounds a message payload's text must satisfy, or `null`. */
    function messageProblem(message: string): CreateRefusal | null {
        return message.length > MAX_NOTIFICATION_BODY_LENGTH
            ? "message-too-long"
            : null;
    }

    /**
     * The bounds a prompt payload must satisfy, or `null`.
     *
     * Blank is its own refusal rather than a length fault: a prompt job with
     * nothing to say would run a model turn about nothing, which is a mistake
     * worth naming. Every door already refuses it (the tool's schema trims and
     * requires one), so this is the policy agreeing with them rather than the
     * only check.
     */
    function promptProblem(prompt: string): CreateRefusal | null {
        if (prompt.trim().length === 0) {
            return "prompt-empty";
        }
        return prompt.length > MAX_NOTIFICATION_BODY_LENGTH
            ? "prompt-too-long"
            : null;
    }

    /**
     * The gate a request asks for, or why it is not one (#90 phases 8f, 8g).
     *
     * Two questions, and these are the halves the policy can answer: the *shape*
     * is the protocol's (`parseJobGate`), and whether the named tool may be
     * read at all is the scheduler's (`gateRefusal` — the same allowlist the
     * runner enforces). Whether the tool is *installed on this server* is the
     * calling door's question, because only it holds the registry, and the
     * runner asks it again at fire time: a stored gate is a durable capability.
     *
     * The parsed value is what gets stored, not the caller's object, so what the
     * runner later compares against is exactly what was validated here.
     */
    function gateCheck(
        gate: unknown,
    ): { ok: true; gate: JobGate | null } | { ok: false; reason: string } {
        if (gate === undefined || gate === null) {
            return { ok: true, gate: null };
        }
        const parsed = parseJobGate(gate);
        if (!parsed.ok) {
            return { ok: false, reason: parsed.reason };
        }
        const refused = gateRefusal(parsed.gate);
        if (refused !== null) {
            return { ok: false, reason: refused };
        }
        return { ok: true, gate: parsed.gate };
    }

    /**
     * The bounds a moment must satisfy for a class, or `null`.
     *
     * The horizon is every class's; the day ceiling is the timer's alone, since
     * a `timer` out loud beyond a day is a reminder that would keep piercing
     * quiet hours.
     */
    function momentProblem(
        jobClass: NotificationClass,
        runAt: Date,
        at: Date,
    ): CreateRefusal | null {
        if (runAt.getTime() <= at.getTime()) {
            // The natural-language path cannot reach this — the resolver
            // refuses a past time before it resolves one — but a page's date
            // picker can, and "in the past" must be a refusal rather than a job
            // that fires the moment it is created.
            return "in-the-past";
        }
        if (runAt.getTime() - at.getTime() > deps.maxHorizonMs) {
            return "beyond-horizon";
        }
        if (
            jobClass === "timer" &&
            runAt.getTime() - at.getTime() > MAX_DURATION_MINUTES * 60_000
        ) {
            return "timer-too-long";
        }
        return null;
    }

    /** The model-facing sentence for a refusal, kept verbatim from the tools. */
    function creationReason(code: CreateRefusal): string {
        switch (code) {
            case "label-too-long":
                return `\`label\` must be at most ${MAX_NOTIFICATION_TITLE_LENGTH} characters — shorten it and try again.`;
            case "message-too-long":
                return `\`message\` must be at most ${MAX_NOTIFICATION_BODY_LENGTH} characters — shorten it and try again.`;
            case "prompt-empty":
                return "a prompt job needs a prompt — say what it should do when it runs.";
            case "prompt-too-long":
                return `\`prompt\` must be at most ${MAX_NOTIFICATION_BODY_LENGTH} characters — shorten it and try again.`;
            case "invalid-gate":
                // The specific fault is the parser's or the read-action policy's
                // (see `gateCheck`), and its reason already says which.
                return "that check is not one this server can make — a gate may only read with a tool that allows it.";
            case "in-the-past":
                return "that moment has already passed — give one in the future.";
            case "beyond-horizon": {
                const days = Math.floor(deps.maxHorizonMs / 86_400_000);
                return `that is more than ${days} days ahead, further than this server schedules.`;
            }
            case "too-many":
                return `the user already has ${deps.maxPerUser} jobs scheduled, which is the limit — cancel one with cancelJob first.`;
            case "timer-too-long":
                return `a countdown longer than ${MAX_DURATION_MINUTES} minutes (a day) is a reminder — use remindMe.`;
            case "invalid-repeat":
                // The specific fault is the parser's (see `repeatCheck`), which
                // knows whether it was a weekday, an ordinal or an end.
                return "that is not a schedule I can keep — check its frequency, days or end.";
            case "store-failed":
                return "the job could not be stored. Tell the user it was not scheduled.";
        }
    }

    /**
     * Stores a job, applying the bounds that keep the queue meaningful: a
     * label/message the announcement can carry, a moment within the horizon,
     * and room under the per-user cap.
     *
     * The cap is about **pending** rows (the ledger's default listing), because
     * that is the work still owed; settled rows are history and the runner's
     * retention prune evicts them first, so a job accepted here can never be the
     * row the prune eats.
     */
    /**
     * The rule a job may carry, or why it may not (#90 phase 8d).
     *
     * Two boundaries live here rather than in the parser, because they are
     * *policy* — what this assistant will schedule — rather than what a rule can
     * mean:
     *
     * - **A timer may not repeat.** A timer pierces quiet hours; a repeating one
     *   would be a standing breach of them, and "every night at 3am" is never a
     *   countdown. A reminder is the class for something that comes back.
     * - **The cadence has a floor** — {@link MIN_REPEAT_MINUTES} ungated, or
     *   {@link MIN_GATED_REPEAT_MINUTES} when the job carries a gate, because a
     *   declined firing announces nothing (the reason written at each).
     *
     * The parse is strict, and its reason is what the user reads: "the 7th
     * Monday" is refused with wording that says which part is impossible.
     */
    function repeatCheck(
        cls: NotificationClass,
        repeat: unknown,
        gated: boolean,
    ): { ok: true; rule: JobRepeat | null } | { ok: false; reason: string } {
        if (repeat === undefined || repeat === null) {
            return { ok: true, rule: null };
        }
        const parsed = parseJobRepeat(repeat);
        if (!parsed.ok) {
            return { ok: false, reason: parsed.reason };
        }
        if (cls === "timer") {
            return {
                ok: false,
                reason: "a timer is a countdown, not a schedule — for something that comes back, use a reminder.",
            };
        }
        const gap = repeatGapMinutes(parsed.repeat);
        const floor = gated ? MIN_GATED_REPEAT_MINUTES : MIN_REPEAT_MINUTES;
        if (gap < floor) {
            const fastest =
                floor === 1 ? "every minute" : `every ${floor} minutes`;
            return {
                ok: false,
                reason: `every ${gap} minute${gap === 1 ? "" : "s"} is too often — the fastest a job may repeat is ${fastest}${
                    gated
                        ? ""
                        : ", or every minute if it carries a gate that can decline a firing"
                }.`,
            };
        }
        return { ok: true, rule: parsed.repeat };
    }

    /**
     * The gap between two occurrences, in minutes, for the shortest rule that
     * frequency can express: a `day` or longer is at least a day, so only the
     * sub-day frequencies can be too fast.
     */
    function repeatGapMinutes(repeat: JobRepeat): number {
        if (repeat.every === "minute") {
            return repeat.interval;
        }
        if (repeat.every === "hour") {
            return repeat.interval * 60;
        }
        return repeat.interval * 1440;
    }

    /**
     * The instant a rule's *next* occurrence falls on, or why there is none.
     *
     * Used for a job's own moment, and for an edit that changes the rule: the
     * rule is the schedule, so a repeating job's `runAt` is derived from it
     * rather than taken from the request — which is what keeps a page's picker
     * and a model's resolution from being a second authority on when it fires.
     */
    function nextRunAt(
        rule: JobRepeat,
        at: Date,
    ): { ok: true; runAt: Date } | { ok: false; reason: string } {
        const next = nextOccurrence(rule, at);
        if (next.ok) {
            return { ok: true, runAt: next.at };
        }
        return {
            ok: false,
            reason:
                next.reason === "ended"
                    ? "that schedule has already ended — give it one that is still ahead."
                    : "that schedule never comes round — check the day or the month it names.",
        };
    }

    function create(userId: number, request: CreateRequest): CreateOutcome {
        const at = request.at ?? now();
        const { label, payload } = request;
        // Before the repeat check, because a gate is what the cadence floor
        // depends on: a gated job may repeat every minute.
        const gated = gateCheck(request.gate);
        if (!gated.ok) {
            return {
                ok: false,
                code: "invalid-gate",
                reason: gated.reason,
            };
        }
        const checked = repeatCheck(
            request.class,
            request.repeat,
            gated.gate !== null,
        );
        if (!checked.ok) {
            return {
                ok: false,
                code: "invalid-repeat",
                reason: checked.reason,
            };
        }
        let runAt = request.runAt;
        if (checked.rule !== null) {
            const derived = nextRunAt(checked.rule, at);
            if (!derived.ok) {
                return {
                    ok: false,
                    code: "invalid-repeat",
                    reason: derived.reason,
                };
            }
            runAt = derived.runAt;
        }
        const problem =
            labelProblem(label) ??
            (payload.kind === "message"
                ? messageProblem(payload.message)
                : payload.kind === "prompt"
                  ? promptProblem(payload.prompt)
                  : null) ??
            momentProblem(request.class, runAt, at);
        if (problem !== null) {
            return {
                ok: false,
                code: problem,
                reason: creationReason(problem),
            };
        }
        const pending = deps.ledger.listJobs(userId, {
            limit: deps.maxPerUser + 1,
        }).length;
        if (pending >= deps.maxPerUser) {
            return {
                ok: false,
                code: "too-many",
                reason: creationReason("too-many"),
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
                    : payload.kind === "prompt"
                      ? { prompt: payload.prompt }
                      : {
                            toolName: payload.toolName,
                            toolArgs: payload.toolArgs,
                        }),
                runAt: runAt.toISOString(),
                ...(checked.rule !== null ? { repeat: checked.rule } : {}),
                ...(gated.gate !== null ? { gate: gated.gate } : {}),
            });
        } catch (err) {
            logger.warn(
                `scheduling a job failed — ${err instanceof Error ? err.message : "unexpected error"}`,
            );
            return {
                ok: false,
                code: "store-failed",
                reason: creationReason("store-failed"),
            };
        }
        logger.info(
            `job ${job.id} scheduled (${job.class}, ${job.kind}${checked.rule !== null ? ", repeating" : ""}${gated.gate !== null ? ", gated" : ""}): "${job.label}" → ${job.runAt}`,
        );
        return {
            ok: true,
            job,
            note: forecastNote(userId, job.class, runAt),
        };
    }

    /**
     * What quiet hours, as they stand, will do to this job's announcement.
     *
     * The read is defensive, because a failed prefs read must never undo a job
     * that was already stored — the forecast is a courtesy, the row is the fact.
     * An unreadable window is "no quiet hours", the same answer the delivery
     * policy gives it.
     */
    function forecast(
        userId: number,
        jobClass: NotificationClass,
        runAt: Date,
    ): QuietForecast {
        let prefs: Record<string, unknown>;
        try {
            prefs = deps.ledger.getPrefs(userId);
        } catch (err) {
            logger.warn(
                `could not read notification prefs for a quiet-hours prediction — ${err instanceof Error ? err.message : "unexpected error"}`,
            );
            return { state: "clear" };
        }
        if (prefs[NOTIFY_ENABLED_PREF] === false) {
            return { state: "disabled" };
        }
        if (!quietHoursHold(prefs, jobClass, runAt)) {
            return { state: "clear" };
        }
        const window = parseQuietHours(prefs[NOTIFY_QUIET_HOURS_PREF]);
        if (window === null) {
            return { state: "clear" };
        }
        // A timer pierces quiet hours by design, which is why `quietHoursHold`
        // answers false for it; the remaining two classes both wait.
        if (jobClass === "timer") {
            return { state: "clear" };
        }
        return {
            state: "held",
            class: jobClass,
            until: quietHoursEnd(window, runAt),
            window: `${clockText(window.start)}–${clockText(window.end)}`,
        };
    }

    /** Renders a forecast for the model, as the tools have always said it. */
    function forecastNote(
        userId: number,
        jobClass: NotificationClass,
        runAt: Date,
    ): string {
        const predicted = forecast(userId, jobClass, runAt);
        if (predicted.state === "disabled") {
            return " Notifications are switched off for this account, so it will be recorded but not pushed — as things stand.";
        }
        if (predicted.state === "clear") {
            return "";
        }
        const endText = format12Hour(
            predicted.until.getHours(),
            predicted.until.getMinutes(),
        );
        if (predicted.class === "reminder") {
            return ` It falls inside quiet hours (${predicted.window}) as things stand, so it will wait until ${endText} and be announced then.`;
        }
        return ` That is inside quiet hours (${predicted.window}) as things stand, so it will be recorded and wait until ${endText} instead of interrupting.`;
    }

    /**
     * Edits a pending job's label, message or moment.
     *
     * The class and the kind are not editable: changing either is a different
     * job, and a class change is how loudly the user gets interrupted, which is
     * not something to mutate in place. A `message` patch is refused on a job
     * that is not a message job, rather than letting the table's kind CHECK
     * throw.
     */
    function edit(
        userId: number,
        id: string,
        patch: {
            label?: string;
            message?: string;
            runAt?: Date;
            repeat?: unknown | null;
        },
    ): EditOutcome {
        const job = deps.ledger.getJob(userId, id);
        if (job === null) {
            return { ok: false, code: "missing", reason: "no such job", job };
        }
        if (job.state !== "pending") {
            return {
                ok: false,
                code: "not-pending",
                reason: `"${job.label}" is ${job.state} now — only a job that has not started can be edited.`,
                job,
            };
        }
        if (patch.message !== undefined && job.kind !== "message") {
            return {
                ok: false,
                code: "not-a-message",
                reason: `"${job.label}" is a ${job.kind} job, so it has no message to edit — change the label or the time instead.`,
                job,
            };
        }
        const at = now();
        const label = patch.label;
        // What the job's rule becomes, and — when it changes — the moment that
        // follows from it. A rule *is* the schedule, so a repeating job's moment
        // comes from the rule rather than from the request: a page's picker and a
        // model's resolution must not be a second authority on when it fires.
        let moment = patch.runAt;
        let rule: unknown | undefined;
        if (patch.repeat !== undefined) {
            // The job's own gate decides the floor: editing a minutely gated
            // series must not turn the schedule it already has into a refusal.
            const checked = repeatCheck(
                job.class,
                patch.repeat,
                job.gate !== null && job.gate !== undefined,
            );
            if (!checked.ok) {
                return {
                    ok: false,
                    code: "invalid-repeat",
                    reason: checked.reason,
                    job,
                };
            }
            rule = checked.rule;
            if (checked.rule !== null) {
                const derived = nextRunAt(checked.rule, at);
                if (!derived.ok) {
                    return {
                        ok: false,
                        code: "invalid-repeat",
                        reason: derived.reason,
                        job,
                    };
                }
                moment = derived.runAt;
            }
        }
        if (label !== undefined) {
            const problem = labelProblem(label);
            if (problem !== null) {
                return {
                    ok: false,
                    code: problem,
                    reason: creationReason(problem),
                    job,
                };
            }
        }
        if (patch.message !== undefined) {
            const problem = messageProblem(patch.message);
            if (problem !== null) {
                return {
                    ok: false,
                    code: problem,
                    reason: creationReason(problem),
                    job,
                };
            }
        }
        if (moment !== undefined) {
            if (moment.getTime() <= at.getTime()) {
                return {
                    ok: false,
                    code: "in-the-past",
                    reason: "that moment has already passed — give one in the future.",
                    job,
                };
            }
            const problem = momentProblem(job.class, moment, at);
            if (problem !== null) {
                return {
                    ok: false,
                    code: problem,
                    reason: creationReason(problem),
                    job,
                };
            }
        }
        const edited = deps.ledger.editJob(userId, id, {
            ...(label !== undefined ? { label } : {}),
            ...(patch.message !== undefined ? { message: patch.message } : {}),
            ...(moment !== undefined ? { runAt: moment.toISOString() } : {}),
            ...(patch.repeat !== undefined ? { repeat: rule } : {}),
        });
        if (edited === null || edited.state !== "pending") {
            // Lost the race to a claim: the row is being worked on now.
            return {
                ok: false,
                code: "not-pending",
                reason: `"${job.label}" is no longer pending — it cannot be edited.`,
                job: edited ?? job,
            };
        }
        logger.info(`job ${edited.id} edited at the user's request`);
        return { ok: true, job: edited };
    }

    /**
     * Settles the announcements a job produced, because the user deferred it
     * (#90 phase 6c).
     *
     * A snoozed reminder is no longer owed an interruption, so the row that
     * announced it says so instead of staying unsettled — which is precisely what
     * kept the toast's Snooze button out of phase 6b: a snooze that moved the job
     * while the card stayed on screen reads as broken. Called only after a move
     * or a re-creation succeeded; a refused snooze must leave the announcement
     * where it was.
     *
     * The ledger refuses a transition out of a terminal state, so a row the user
     * had already read or dismissed is left exactly as it is.
     */
    function settleAnnouncements(userId: number, jobId: string): void {
        for (const notification of deps.ledger.listNotificationsForJob(
            userId,
            jobId,
        )) {
            deps.ledger.setNotificationState(
                userId,
                notification.id,
                "snoozed",
            );
        }
    }

    /**
     * Snoozes a reminder: a pending one moves, a settled one is set again with
     * the payload it had.
     *
     * A move counts no attempt and announces nothing, because nothing was
     * tried. A settled job is re-created rather than reopened — its history is
     * what happened, and a second moment is a second job — which is also why
     * the new id comes back: it is what the user's list will show.
     */
    function snooze(
        userId: number,
        id: string,
        minutes: number,
    ): SnoozeOutcome {
        const at = now();
        const job = deps.ledger.getJob(userId, id);
        if (job === null) {
            return {
                ok: false,
                code: "missing",
                reason: `There is no job with the id "${id}".`,
                job: null,
            };
        }
        if (job.class !== "reminder") {
            return {
                ok: false,
                code: "not-a-reminder",
                reason: `"${job.label}" is a ${job.class}, not a reminder.`,
                job,
            };
        }
        if (
            !Number.isFinite(minutes) ||
            minutes < MIN_SNOOZE_MINUTES ||
            minutes > MAX_SNOOZE_MINUTES
        ) {
            return {
                ok: false,
                code: "invalid-minutes",
                reason: `\`minutes\` must be between ${MIN_SNOOZE_MINUTES} and ${MAX_SNOOZE_MINUTES} (a week).`,
                job,
            };
        }
        if (job.state === "cancelled") {
            return {
                ok: false,
                code: "cancelled",
                reason: `"${job.label}" was cancelled.`,
                job,
            };
        }
        // A claimed job is mid-run; re-creating it would tell the user twice for
        // one moment.
        if (job.state === "running") {
            return {
                ok: false,
                code: "running",
                reason: `"${job.label}" is running right now.`,
                job,
            };
        }
        const runAt = new Date(at.getTime() + minutes * 60_000);
        if (job.state === "pending") {
            const moved = deps.ledger.moveJob(userId, id, runAt.toISOString());
            if (moved === null || moved.runAt !== runAt.toISOString()) {
                return {
                    ok: false,
                    code: "cannot-move",
                    reason: `"${job.label}" is ${moved?.state ?? "running"} now — it cannot be moved.`,
                    job: moved ?? job,
                };
            }
            logger.info(`job ${job.id} snoozed to ${moved.runAt}`);
            settleAnnouncements(userId, id);
            return {
                ok: true,
                action: "moved",
                job: moved,
                runAt,
                previousRunAt: null,
                note: forecastNote(userId, "reminder", runAt),
            };
        }
        // Already had its moment (done/failed/missed): a snooze is a fresh
        // reminder for the same thing, with the same payload it had.
        const payload = snoozePayload(job);
        if (payload === null) {
            return {
                ok: false,
                code: "not-repeatable",
                reason: `"${job.label}" is a ${job.kind} job, and snoozing it would not repeat what it does.`,
                job,
            };
        }
        const outcome = create(userId, {
            label: job.label,
            class: "reminder",
            payload,
            runAt,
            at,
        });
        if (!outcome.ok) {
            return {
                ok: false,
                code: outcome.code,
                reason: outcome.reason,
                job,
            };
        }
        // The announcement belongs to the job the user acted on, not to its
        // successor: the new reminder will announce its own moment when it comes.
        settleAnnouncements(userId, id);
        return {
            ok: true,
            action: "recreated",
            job: outcome.job,
            runAt,
            previousRunAt: new Date(job.runAt),
            note: outcome.note,
        };
    }

    return { create, forecast, edit, snooze };
}

/**
 * The payload a settled reminder is re-created with when it is snoozed.
 *
 * `message` and `tool` are the two kinds a reminder can hold today; a `prompt`
 * reminder (only reachable from a future REST surface) is refused rather than
 * silently turned into a message job, which would run something different from
 * what was scheduled.
 */
export function snoozePayload(job: AppJob): JobPayload | null {
    if (job.kind === "message") {
        return { kind: "message", message: job.message ?? job.label };
    }
    if (job.kind === "tool" && job.toolName !== null) {
        const args = job.toolArgs;
        return {
            kind: "tool",
            toolName: job.toolName,
            toolArgs:
                typeof args === "object" &&
                args !== null &&
                !Array.isArray(args)
                    ? (args as Record<string, unknown>)
                    : {},
        };
    }
    return null;
}

/** `22:00` → `10:00 PM`, for a quiet-hours window as the user set it. */
function clockText(value: string): string {
    const [hours, minutes] = value.split(":").map((part) => Number(part));
    return format12Hour(hours, minutes);
}
