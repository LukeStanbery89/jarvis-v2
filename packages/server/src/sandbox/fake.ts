/**
 * An in-memory {@link SandboxRunner} for tests (#141).
 *
 * The runner seam exists so the supervisor and the boot reaper can be proven
 * without a Docker daemon: containers become state this module owns, and a test
 * says when one produces a line or exits instead of waiting for a real process.
 * It is deterministic on purpose — nothing here is timed, so a suite never
 * sleeps and never races a container's startup.
 *
 * Seeded containers are how a *crash* is expressed: a test builds a runner that
 * already holds a container (the state a booting process finds after its
 * predecessor died), then runs `reconcileCodingJobs` against it. Started ones
 * behave the same way, with the id assigned in order (`fake-1`, `fake-2`, …) so
 * an assertion can name them.
 */
import type {
    SandboxContainer,
    SandboxExit,
    SandboxHandle,
    SandboxRunner,
    SandboxSpec,
} from "./types";

/** The sentinel a closed log channel yields after its last buffered line. */
const END: unique symbol = Symbol("sandbox-log-end");

/** One buffered item, or the end of the stream. */
type ChannelItem<T> = T | typeof END;

/**
 * A minimal single-consumer channel.
 *
 * Logs are push-shaped (`emit`) but consumed pull-shaped (`for await`), and the
 * fake must not lose a line that arrives between two reads. A queue plus one
 * pending waiter is the whole contract; a real event emitter would also work
 * but would leave the "who reads first" ordering to the test.
 */
interface Channel<T> {
    push(value: T): void;
    close(): void;
    next(): Promise<ChannelItem<T>>;
}

/**
 * Builds an unbounded channel.
 *
 * @returns The channel's three operations.
 */
function createChannel<T>(): Channel<T> {
    const items: T[] = [];
    let waiter: ((value: ChannelItem<T>) => void) | null = null;
    let closed = false;

    return {
        push(value: T): void {
            if (closed) {
                return;
            }
            if (waiter !== null) {
                const resolve = waiter;
                waiter = null;
                resolve(value);
                return;
            }
            items.push(value);
        },
        close(): void {
            if (closed) {
                return;
            }
            closed = true;
            if (waiter !== null) {
                const resolve = waiter;
                waiter = null;
                resolve(END);
            }
        },
        async next(): Promise<ChannelItem<T>> {
            if (items.length > 0) {
                return items.shift() as T;
            }
            if (closed) {
                return END;
            }
            return new Promise<ChannelItem<T>>((resolve) => {
                waiter = resolve;
            });
        },
    };
}

/** One container the fake knows about. */
interface FakeContainerState {
    containerId: string;
    jobId: string;
    running: boolean;
    startedAt: string | null;
    logs: Channel<string>;
    exited: SandboxExit | null;
    waiters: Array<(exit: SandboxExit) => void>;
}

/** A container a test wants the runner to find before anything starts. */
export interface FakeContainerSeed {
    /** Defaults to `fake-<n>`, in seed order. */
    containerId?: string;
    /** The coding job the container label names. */
    jobId: string;
    /** Defaults to `true`; `false` seeds a container whose process already ended. */
    running?: boolean;
    /** Its exit code when seeded as not running. Defaults to `0`. */
    exitCode?: number | null;
    /** Lines already in its log. */
    logs?: readonly string[];
    /** Defaults to "now" — only used when a test asserts the listing's timestamp. */
    startedAt?: string;
}

/**
 * The fake runner, plus the controls a test needs to drive it.
 *
 * The controls are deliberately *not* on {@link SandboxRunner}: the production
 * code must never be able to emit a log line or end a container, which is
 * exactly what makes the fake safe to hand to it.
 */
export interface FakeSandbox extends SandboxRunner {
    /** Every spec started through {@link SandboxRunner.start}, in order. */
    readonly started: readonly SandboxSpec[];
    /** Every container id removed, in order (repeats included). */
    readonly removed: readonly string[];
    /** Appends one line to a container's stream. */
    emit(containerId: string, line: string): void;
    /** Ends a container's process, resolving its `wait()`. */
    exit(containerId: string, exitCode?: number | null): void;
}

/**
 * Builds the fake runner.
 *
 * @param options - Containers to seed, as a booting process would find them.
 * @returns The runner and its test controls.
 */
export function createFakeSandbox(
    options: {
        containers?: readonly FakeContainerSeed[];
        /** What {@link SandboxRunner.networkIsInternal} reports; default true. */
        networkIsInternal?: boolean;
    } = {},
): FakeSandbox {
    const states = new Map<string, FakeContainerState>();
    const retired = new Set<string>();
    const startedSpecs: SandboxSpec[] = [];
    const removed: string[] = [];
    let counter = 0;

    /**
     * Ends a container if it is still running.
     *
     * @param state - The container to end.
     * @param exitCode - Its exit code, or `null` for "stopped, no code".
     */
    function endContainer(
        state: FakeContainerState,
        exitCode: number | null,
    ): void {
        if (state.exited !== null) {
            return;
        }
        state.running = false;
        state.exited = { exitCode };
        state.logs.close();
        for (const resolve of state.waiters) {
            resolve(state.exited);
        }
        state.waiters.length = 0;
    }

    /**
     * Wraps a container state in the handle the supervisor sees.
     *
     * @param state - The container.
     * @returns A handle whose `remove` also retires the container from the listing.
     */
    function handleFor(state: FakeContainerState): SandboxHandle {
        return {
            containerId: state.containerId,
            async *logs(): AsyncIterable<string> {
                for (;;) {
                    const item = await state.logs.next();
                    if (item === END) {
                        return;
                    }
                    yield item;
                }
            },
            wait(): Promise<SandboxExit> {
                if (state.exited !== null) {
                    return Promise.resolve(state.exited);
                }
                return new Promise<SandboxExit>((resolve) => {
                    state.waiters.push(resolve);
                });
            },
            async stop(): Promise<void> {
                endContainer(state, null);
            },
            async remove(): Promise<void> {
                endContainer(state, null);
                retired.add(state.containerId);
                removed.push(state.containerId);
            },
        };
    }

    /**
     * Registers one container.
     *
     * @param seed - The container's starting state.
     * @returns The stored state.
     */
    function add(seed: FakeContainerSeed): FakeContainerState {
        const containerId = seed.containerId ?? `fake-${++counter}`;
        const running = seed.running ?? true;
        const state: FakeContainerState = {
            containerId,
            jobId: seed.jobId,
            running,
            startedAt: seed.startedAt ?? new Date().toISOString(),
            logs: createChannel<string>(),
            exited: null,
            waiters: [],
        };
        for (const line of seed.logs ?? []) {
            state.logs.push(line);
        }
        if (!running) {
            endContainer(state, seed.exitCode ?? 0);
        }
        states.set(containerId, state);
        return state;
    }

    for (const seed of options.containers ?? []) {
        add(seed);
    }

    return {
        started: startedSpecs,
        removed,
        async start(spec: SandboxSpec): Promise<SandboxHandle> {
            startedSpecs.push(spec);
            const state = add({ jobId: spec.jobId });
            return handleFor(state);
        },
        async adopt(containerId: string): Promise<SandboxHandle | null> {
            const state = states.get(containerId);
            if (state === undefined || retired.has(containerId)) {
                return null;
            }
            return handleFor(state);
        },
        async list(): Promise<SandboxContainer[]> {
            return [...states.values()]
                .filter((state) => !retired.has(state.containerId))
                .map((state) => ({
                    containerId: state.containerId,
                    jobId: state.jobId,
                    running: state.running,
                    startedAt: state.startedAt,
                }));
        },
        async networkIsInternal(): Promise<boolean> {
            return options.networkIsInternal ?? true;
        },
        async remove(containerId: string): Promise<void> {
            const state = states.get(containerId);
            if (state === undefined) {
                removed.push(containerId);
                return;
            }
            endContainer(state, null);
            retired.add(containerId);
            removed.push(containerId);
        },
        emit(containerId: string, line: string): void {
            const state = states.get(containerId);
            if (state === undefined) {
                throw new Error(`fake sandbox: no container ${containerId}`);
            }
            state.logs.push(line);
        },
        exit(containerId: string, exitCode: number | null = 0): void {
            const state = states.get(containerId);
            if (state === undefined) {
                throw new Error(`fake sandbox: no container ${containerId}`);
            }
            endContainer(state, exitCode);
        },
    };
}
