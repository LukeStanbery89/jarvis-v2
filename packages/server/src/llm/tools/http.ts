/**
 * The shared HTTP transport behind the hand-rolled provider clients (#103).
 *
 * Every metered tool's client (OpenWeather, Home Assistant, Tavily, Serper)
 * used to hand-roll the same ~35-line scaffold — fetch with a timeout, map
 * transport/HTTP/JSON failures onto a typed provider error, parse the JSON
 * body — and every copy carried the same footgun: `signal ??
 * AbortSignal.timeout(ms)` REPLACED the configured timeout whenever a caller
 * signal was present. Threading a turn's `AbortSignal` through that shape
 * silently removed the client timeout for cancelled turns, so a hung host
 * could hold a turn's thread lock for the full fetch with no bound at all.
 *
 * `requestJson` owns the correct composition instead: the caller's signal and
 * the configured timeout are COMBINED with `AbortSignal.any` — either one
 * aborts the request, and neither is dropped. The provider-specific parts
 * stay with the provider via two seams: an optional `httpErrorText` hook
 * (OpenWeather surfaces the body's reason with the key scrubbed; Home
 * Assistant scrubs the token and trims; the default is `"<label> returned
 * <status>"`) and a required `mapFailure` that turns the transport-shaped
 * {@link ToolHttpFailure} into the client's own typed error. The original
 * error travels on the failure as `cause` so wrappers stop dropping stacks.
 */

/**
 * A transport-level failure of one `requestJson` call, before mapping.
 *
 * `unreachable` — the fetch itself rejected (transport failure or abort);
 * `http` — the response was not ok (`status` set, `cause` is the Response);
 * `json` — the body could not be parsed.
 */
export type ToolHttpFailure = {
    /** Which stage failed. */
    kind: "unreachable" | "http" | "json";
    /** The provider-facing message, already built (`"<label> …"` shapes). */
    message: string;
    /** The response's HTTP status, for `kind: "http"`. */
    status?: number;
    /** The underlying error (or Response); the mapper chains it as `cause`. */
    cause?: unknown;
};

/** Maps a transport failure onto the calling client's typed error. */
export type ToolFailureMapper = (failure: ToolHttpFailure) => Error;

/** Options for {@link requestJson}. */
export interface RequestJsonOptions {
    /** The absolute URL to fetch (query string included). */
    url: string;
    /**
     * Provider name used in the built failure messages
     * (`"<label> unreachable: …"`, `"<label> returned invalid JSON"`) —
     * exactly the strings the hand-rolled clients emitted.
     */
    label: string;
    /** Wall-clock cap for the request; combined with `signal`, never replaced. */
    timeoutMs: number;
    /** The caller's signal (e.g. the turn's), combined with the timeout. */
    signal?: AbortSignal;
    /** HTTP method; `GET` when omitted. */
    method?: "GET" | "POST";
    /** Request headers; none when omitted. */
    headers?: Record<string, string>;
    /** A pre-stringified JSON request body, when the call posts one. */
    body?: string;
    /** Skip the body parse and resolve `undefined` (Home Assistant's writes). */
    ignoreBody?: boolean;
    /** Injectable for tests (defaults to global `fetch`). */
    fetchImpl?: typeof fetch;
    /**
     * Builds the message for a non-2xx response, reading the untrusted body
     * as needed (scrubbing any secrets first). Defaults to a bare status.
     */
    httpErrorText?: (response: Response) => Promise<string> | string;
    /** Turns the failure into the client's typed error; the helper throws it. */
    mapFailure: ToolFailureMapper;
}

/**
 * GETs or POSTs one JSON endpoint and resolves the parsed body.
 *
 * The caller's signal and the configured timeout are combined — a cancelled
 * caller aborts immediately, a quiet caller is still bounded by the timeout —
 * and every failure path (transport, HTTP, JSON) goes through `mapFailure`,
 * so the throwing contract is exactly the client's own typed error.
 */
export async function requestJson(opts: RequestJsonOptions): Promise<unknown> {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const effectiveSignal = opts.signal
        ? AbortSignal.any([opts.signal, timeout])
        : timeout;
    const doFetch = opts.fetchImpl ?? fetch;
    let response: Response;
    try {
        // The init is built minimally so each client's observed request shape
        // stays exactly what its hand-rolled predecessor sent (GETs carry no
        // method or header fields; header-less GETs send `{ signal }` only).
        response = await doFetch(opts.url, {
            ...(opts.method === undefined || opts.method === "GET"
                ? {}
                : { method: opts.method }),
            ...(opts.headers === undefined ? {} : { headers: opts.headers }),
            ...(opts.body === undefined ? {} : { body: opts.body }),
            signal: effectiveSignal,
        });
    } catch (err) {
        throw opts.mapFailure({
            kind: "unreachable",
            message: `${opts.label} unreachable: ${
                err instanceof Error ? err.message : "unknown error"
            }`,
            cause: err,
        });
    }
    if (!response.ok) {
        const message = opts.httpErrorText
            ? await opts.httpErrorText(response)
            : `${opts.label} returned ${response.status}`;
        throw opts.mapFailure({
            kind: "http",
            status: response.status,
            message,
            cause: response,
        });
    }
    if (opts.ignoreBody) {
        return undefined;
    }
    try {
        return await response.json();
    } catch (err) {
        throw opts.mapFailure({
            kind: "json",
            message: `${opts.label} returned invalid JSON`,
            cause: err,
        });
    }
}

/** Defensive field coercion for untrusted provider JSON: a string or "". */
export function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** Defensive field coercion for untrusted provider JSON: a number or NaN. */
export function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}
