/**
 * Shared leveled logging for J.A.R.V.I.S. packages.
 *
 * Wraps Consola (https://consola.unjs.io) behind a small, opinionated API:
 * `createLogger` returns a logger whose `debug`/`info`/`warn`/`error` methods
 * emit timestamped, level-tagged lines. Consola handles log-object creation and
 * level filtering (a message is emitted when its severity is at or below the
 * configured level); output rendering is a custom reporter so every line looks
 * like `YYYY-MM-DD HH:mm:ss [LEVEL] tag — message`, colorized by level when
 * colors are enabled.
 *
 * Consumers are the other `@jarvis/*` packages (`createLogger({ tag })` per
 * package, see the package README). The default level is `info`, overridable
 * per logger, via the `JARVIS_LOG_LEVEL` env var, or per-instance `level`.
 *
 * Sensitive payloads (user prompts, response text) are logged through the
 * `sensitive`/`sensitiveDebug` methods. Payloads are `[REDACTED]` by default;
 * they are only rendered in full when the logger runs in development
 * (`NODE_ENV=development`) or `JARVIS_LOG_SENSITIVE=full` is set.
 */
import { createConsola, LogLevels } from "consola/core";
import type { ConsolaReporter, LogObject } from "consola/core";

/** Supported log levels, from quietest to most verbose. */
export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Whether sensitive payloads are rendered verbatim (`"full"`) or as
 * `[REDACTED]`/suppressed (`"redacted"`). Defaults to `"redacted"`; only
 * `NODE_ENV=development` (or an explicit `JARVIS_LOG_SENSITIVE` setting)
 * switches to `"full"`.
 */
export type SensitiveMode = "full" | "redacted";

/** Minimal writable-stream shape (satisfied by Node streams and pass-throughs). */
export interface Writable {
    write(chunk: string): unknown;
}

/** Options accepted by {@link createLogger}. */
export interface LoggerOptions {
    /** Tag attributed to every emitted line (for example `"server"` or `"cli"`). */
    tag: string;
    /** Minimum level to emit. Defaults to `JARVIS_LOG_LEVEL` env, else `"info"`. */
    level?: LogLevel;
    /**
     * Whether to colorize the `[LEVEL]` label. Defaults to auto-detection:
     * disabled when `NO_COLOR` is set, enabled when `FORCE_COLOR` is set or the
     * target stream is a TTY.
     */
    color?: boolean;
    /**
     * Writable stream for all output. Defaults to `process.stdout`/`stderr` by
     * severity (matching `console.info`/`console.error`); falls back to the
     * browser `console` when neither a stream nor `process` is available.
     */
    stream?: Writable;
    /**
     * Whether sensitive payloads are rendered verbatim. Defaults to `"redacted"`,
     * switched to `"full"` when `NODE_ENV=development` (or overridden via the
     * `JARVIS_LOG_SENSITIVE` env var).
     */
    sensitive?: SensitiveMode;
}

/** A leveled logger that writes timestamped, tagged lines. */
export interface Logger {
    /** The resolved minimum level being emitted. */
    readonly level: LogLevel;
    /** Whether sensitive payloads are rendered verbatim (`"full"`) or scrubbed (`"redacted"`). */
    readonly sensitiveMode: SensitiveMode;
    /** Emits a debug-level message (hidden unless the configured level is `debug`). */
    debug(message: unknown): void;
    /** Emits an info-level message. */
    info(message: unknown): void;
    /** Emits a warn-level message. */
    warn(message: unknown): void;
    /** Emits an error-level message. */
    error(message: unknown): void;
    /**
     * Emits an info-level event carrying a sensitive payload. The `detail` is
     * rendered verbatim in `"full"` mode and replaced with `[REDACTED]` in
     * `"redacted"` mode; the event name is always visible.
     */
    sensitive(event: string, detail?: unknown): void;
    /**
     * Emits a debug-level event carrying sensitive detail. Emitted only in
     * `"full"` mode (and subject to the log level); suppressed entirely in
     * `"redacted"` mode so payloads can never leak even at the debug level.
     */
    sensitiveDebug(event: string, detail: unknown): void;
}

const LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

/** Maps our `LogLevel` names onto Consola's numeric severities. */
const LEVEL_TO_NUMBER: Record<LogLevel, number> = {
    error: LogLevels.error,
    warn: LogLevels.warn,
    info: LogLevels.info,
    debug: LogLevels.debug,
};

/** ANSI color codes for each level's `[LEVEL]` label. */
const LEVEL_COLORS: Record<string, number> = {
    error: 31, // red
    warn: 33, // yellow
    info: 32, // green
    debug: 36, // cyan
};

/**
 * Creates a logger for a package.
 *
 * Callers pass a human-readable `tag` used to attribute every line. The level
 * is resolved from `options.level`, falling back to the `JARVIS_LOG_LEVEL`
 * environment variable, falling back to `"info"`. The sensitive mode is
 * resolved from `options.sensitive`, falling back to `JARVIS_LOG_SENSITIVE`,
 * then to `"redacted"` unless `NODE_ENV=development` (see
 * {@link resolveSensitiveMode}).
 */
export function createLogger(options: LoggerOptions): Logger {
    const level = resolveLevel(options.level);
    const mode = resolveSensitiveMode(options.sensitive);
    const color = options.color ?? resolveAutoColor(options.stream);

    const consola = createConsola({
        level: LEVEL_TO_NUMBER[level],
        defaults: { tag: options.tag },
        reporters: [createLineReporter(options.stream, color)],
    });

    return {
        level,
        sensitiveMode: mode,
        debug: (message: unknown): void => {
            consola.debug(message);
        },
        info: (message: unknown): void => {
            consola.info(message);
        },
        warn: (message: unknown): void => {
            consola.warn(message);
        },
        error: (message: unknown): void => {
            consola.error(message);
        },
        sensitive: (event: string, detail?: unknown): void => {
            consola.info(formatSensitiveEvent(event, detail, mode));
        },
        sensitiveDebug: (event: string, detail: unknown): void => {
            if (mode === "redacted") {
                return;
            }
            consola.debug(`${event}: ${formatMessage(detail)}`);
        },
    };
}

/**
 * Renders a sensitive event: the event name always remains visible, while the
 * `detail` is either appended verbatim (`"full"`) or replaced with
 * `[REDACTED]` (`"redacted"`). A colon separates the event from its payload so
 * redaction reads as a labeled value rather than part of the message.
 */
function formatSensitiveEvent(
    event: string,
    detail: unknown,
    mode: SensitiveMode,
): string {
    if (detail === undefined) {
        return event;
    }
    return mode === "redacted"
        ? `${event}: [REDACTED]`
        : `${event}: ${formatMessage(detail)}`;
}

/**
 * Builds the Consola reporter that renders each log object as
 * `YYYY-MM-DD HH:mm:ss [LEVEL] tag — message` and writes it to the target
 * stream (or falls back to the browser `console`).
 */
function createLineReporter(
    stream: Writable | undefined,
    color: boolean,
): ConsolaReporter {
    return {
        log(logObj: LogObject): void {
            const line = formatLine(logObj, color);
            const target = stream ?? defaultStreamFor(logObj.type);
            if (target) {
                target.write(line + "\n");
                return;
            }
            const consoleFn = (console as unknown as Record<string, unknown>)[
                logObj.type
            ];
            if (typeof consoleFn === "function") {
                consoleFn(line);
            }
        },
    };
}

/** Formats one log object as a single timestamped, level-tagged line. */
function formatLine(logObj: LogObject, color: boolean): string {
    const level = logObj.type.toUpperCase();
    const label = color
        ? colorize(LEVEL_COLORS[logObj.type] ?? 0, level)
        : level;
    const time = formatTimestamp(logObj.date ?? new Date());
    return `${time} [${label}] ${logObj.tag} — ${formatMessage(logObj.args[0])}`;
}

/** Formats a value for display; Errors render as their message, objects as JSON. */
function formatMessage(value: unknown): string {
    if (value instanceof Error) {
        return value.message;
    }
    if (typeof value === "object" && value !== null) {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

/** Formats a `Date` as `YYYY-MM-DD HH:mm:ss` in local time. */
function formatTimestamp(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}

/** Wraps `text` in an ANSI color code. */
function colorize(code: number, text: string): string {
    return `\u001b[${code}m${text}\u001b[0m`;
}

/** Resolves the effective level from an explicit value or the environment. */
function resolveLevel(explicit: LogLevel | undefined): LogLevel {
    if (explicit) {
        return explicit;
    }
    const fromEnv =
        typeof process !== "undefined"
            ? process.env.JARVIS_LOG_LEVEL
            : undefined;
    const normalized = fromEnv?.toLowerCase();
    return (LEVELS as readonly string[]).includes(normalized ?? "")
        ? (normalized as LogLevel)
        : "info";
}

/**
 * Picks the default stream for a log type, mirroring `console` semantics.
 */
function defaultStreamFor(type: string): Writable | undefined {
    if (typeof process === "undefined") {
        return undefined;
    }
    return type === "info" || type === "debug"
        ? process.stdout
        : process.stderr;
}

/**
 * Resolves the sensitive mode from an explicit option, the
 * `JARVIS_LOG_SENSITIVE` env var, or the runtime environment.
 *
 * Payloads are `[REDACTED]` by default (always safe); they are rendered
 * verbatim (`"full"`) only when explicitly requested or when running in
 * development (`NODE_ENV=development`).
 */
function resolveSensitiveMode(
    explicit: SensitiveMode | undefined,
): SensitiveMode {
    if (explicit) {
        return explicit;
    }
    const fromEnv =
        typeof process !== "undefined"
            ? process.env.JARVIS_LOG_SENSITIVE
            : undefined;
    const normalized = fromEnv?.toLowerCase();
    if (normalized === "full" || normalized === "redacted") {
        return normalized;
    }
    if (
        typeof process !== "undefined" &&
        process.env.NODE_ENV === "development"
    ) {
        return "full";
    }
    return "redacted";
}

/** Auto-detects whether color output should be enabled. */
function resolveAutoColor(stream: Writable | undefined): boolean {
    if (typeof process === "undefined") {
        return false;
    }
    if (process.env.NO_COLOR !== undefined) {
        return false;
    }
    if (
        process.env.FORCE_COLOR !== undefined &&
        process.env.FORCE_COLOR !== "0"
    ) {
        return true;
    }
    const target = stream ?? process.stdout;
    return (target as { isTTY?: unknown }).isTTY === true;
}
