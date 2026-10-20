/**
 * The sandbox seam (#141).
 *
 * A coding job runs model-directed work in a container the server did not
 * build a turn for: it outlives a `/ws` prompt, it is minutes to hours long,
 * and it must be disposable. This module defines the *shape* of that
 * capability and nothing else — no Docker, no SQLite, no policy — so the
 * supervisor can be written and tested against a fake before a daemon is
 * involved, and so the Docker implementation is one pluggable part rather than
 * the architecture.
 *
 * The seam has one non-obvious member. {@link SandboxRunner.adopt} exists
 * because a container is a process in its own right: when JARVIS restarts, a
 * job's container keeps running, and the boot reaper must be able to *rejoin*
 * it (read its state and tail its logs) rather than guess that it died. That
 * is the `resume` half of a job's {@link CrashPolicy}; the `prune` half removes
 * it instead.
 */
import type { CodingJobCrashPolicy } from "@lukestanbery/jarvis-auth";

/** The label key that marks a container as one of JARVIS's own. */
export const SANDBOX_MANAGED_LABEL = "jarvis.managed";

/**
 * The value {@link SANDBOX_MANAGED_LABEL} carries.
 *
 * A word rather than `true` so `docker ps --filter label=jarvis.managed` is
 * legible in a terminal, and so a future runner (a daemon, a second host) can
 * identify itself without pretending to be a boolean.
 */
export const SANDBOX_MANAGED_BY = "jarvis";

/** The label key that names the coding job a container serves. */
export const SANDBOX_JOB_LABEL = "jarvis.job";

/** Where a workspace is mounted when a spec does not say otherwise. */
export const SANDBOX_WORKSPACE_TARGET = "/workspace";

/**
 * What happens to a job whose server died mid-run (#141).
 *
 * A re-export rather than a second definition: the policy is stored on the
 * job row, so its closed set belongs to the store, and the sandbox reads it.
 */
export type CrashPolicy = CodingJobCrashPolicy;

/** The resource envelope a container runs inside. */
export interface SandboxLimits {
    /** CPU cores the container may use. */
    cpus: number;
    /** Memory ceiling in MiB. */
    memoryMb: number;
    /** Process-count ceiling — the cheapest guard against a fork bomb. */
    pids: number;
    /** Wall-clock ceiling; the supervisor stops the container when it expires. */
    wallClockMs: number;
}

/** Everything needed to start one job's container. */
export interface SandboxSpec {
    /** The coding job this container serves; becomes the `jarvis.job` label. */
    jobId: string;
    /** The job image (agent + toolchain), built by this repository. */
    image: string;
    /**
     * The workspace path **as the Docker daemon sees it** — the host path, not
     * the server's view. A container path here silently mounts an empty
     * directory, which is the trap the probe documents.
     */
    workspacePath: string;
    /** Where the workspace lands inside the container; defaults to `/workspace`. */
    workspaceTarget?: string;
    /** The container's argv. */
    command: readonly string[];
    /** Environment handed to the container. No secrets unless the job owns one. */
    env: Readonly<Record<string, string>>;
    limits: SandboxLimits;
    /**
     * Writable tmpfs mounts for the read-only root, keyed by container path.
     *
     * A container whose root is read-only still needs somewhere to write
     * scratch files and a home directory; the runner defaults to `/tmp` and
     * the service adds whatever its image needs (`HOME`).
     */
    tmpfs?: Readonly<Record<string, string>>;
    /**
     * Extra `/etc/hosts` entries (`host:ip` or `host:host-gateway`).
     *
     * Defaults to `host.docker.internal:host-gateway`, because a job container
     * that cannot reach its model is a job that cannot work; an operator whose
     * engine already provides that name can pass an empty list.
     */
    extraHosts?: readonly string[];
}

/** One of JARVIS's containers, as a listing sees it. */
export interface SandboxContainer {
    containerId: string;
    /** The `jarvis.job` label — empty when the label is missing or unreadable. */
    jobId: string;
    /** Whether the container's process is still running. */
    running: boolean;
    /** When it started, as the daemon reports it (ISO-8601), or `null`. */
    startedAt: string | null;
}

/** How a container's life ended. */
export interface SandboxExit {
    /** The process's exit code, or `null` when the daemon has none. */
    exitCode: number | null;
}

/** A handle on one container: the supervisor's whole view of a running job. */
export interface SandboxHandle {
    readonly containerId: string;
    /**
     * The container's output, line by line, until the container is gone.
     *
     * Lines already written are replayed first, so adopting a container
     * mid-life does not lose the part the dead process had already seen. Pass
     * `since` to skip to a timestamp instead (a resume that recorded its last
     * read).
     */
    logs(options?: { since?: string }): AsyncIterable<string>;
    /** Resolves when the container exits; never rejects for a normal exit. */
    wait(): Promise<SandboxExit>;
    /** Asks the container to stop, then kills it after a grace period. Idempotent. */
    stop(): Promise<void>;
    /** Stops and removes it. Idempotent — removing a gone container is a no-op. */
    remove(): Promise<void>;
}

/**
 * The runner seam: every operation a supervisor or reaper needs, and nothing
 * about how it is done.
 *
 * `list()` is deliberately label-scoped. A reaper that enumerated and removed
 * "containers" would be able to take down anything else on the host, the
 * server's own container included; the seam's contract is that it only ever
 * sees its own fleet.
 */
export interface SandboxRunner {
    start(spec: SandboxSpec): Promise<SandboxHandle>;
    /**
     * Reattaches to a container by id.
     *
     * @returns A handle when the container still exists — running or exited,
     * because its logs remain readable — or `null` when it is gone.
     */
    adopt(containerId: string): Promise<SandboxHandle | null>;
    /** Every container labelled as JARVIS's, across jobs. */
    list(): Promise<SandboxContainer[]>;
    /** Removes a container by id, stopping it first if needed. Idempotent. */
    remove(containerId: string): Promise<void>;
}
