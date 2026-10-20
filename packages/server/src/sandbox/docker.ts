/**
 * The Docker implementation of the sandbox seam (#141).
 *
 * This is the only module that knows containers exist. Everything above it —
 * the supervisor, the boot reaper — talks to {@link SandboxRunner}, so the
 * policy stays testable against the fake and this file stays a translation
 * layer: build a create request, start it, stream its logs, wait, remove.
 *
 * Three choices are worth stating because they are security decisions, not
 * style:
 *
 * - **The workspace is the only mount**, read-write, and it is the *host* path
 *   the caller supplies. No `$HOME`, no docker socket, no `/var/run`.
 * - **The root filesystem is read-only**, with tmpfs for scratch space, so the
 *   only durable artifact a job can produce is a change in its workspace.
 * - **The container is unprivileged and bounded**: `CapDrop: ALL`,
 *   `no-new-privileges`, a non-root uid from the image, and CPU / memory /
 *   process / wall-clock ceilings.
 *
 * `dockerode` is used rather than the `docker` CLI because the server's runtime
 * image is `-slim` with no toolchain (a CLI binary would be *heavier* than one
 * dependency), and because a client keeps the API structured instead of
 * parsing another program's text. The client is injectable so tests assert the
 * exact request without a daemon.
 */
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import {
    SANDBOX_JOB_LABEL,
    SANDBOX_MANAGED_BY,
    SANDBOX_MANAGED_LABEL,
    SANDBOX_WORKSPACE_TARGET,
    type SandboxContainer,
    type SandboxExit,
    type SandboxHandle,
    type SandboxRunner,
    type SandboxSpec,
} from "./types";

/** Where the daemon's socket lives when the caller does not say. */
export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";

/** Grace before a stop becomes a kill. */
const STOP_GRACE_SECONDS = 10;

/** The scratch space a read-only root still needs (sticky world-writable). */
const DEFAULT_TMPFS: Readonly<Record<string, string>> = {
    "/tmp": "rw,noexec,nosuid,size=256m,mode=1777",
};

/**
 * The host alias a job needs to reach its model.
 *
 * Same spelling `docker-compose.yml` gives the server itself. Harmless on
 * engines that already provide the name (OrbStack, Docker Desktop), necessary
 * on plain Docker Engine for Linux; a spec can override it with `[]`.
 */
const DEFAULT_EXTRA_HOSTS: readonly string[] = [
    "host.docker.internal:host-gateway",
];

/** The create request this module builds, as a value tests can assert. */
export interface DockerCreateOptions {
    name: string;
    Image: string;
    Labels: Record<string, string>;
    Env: string[];
    Cmd: string[];
    WorkingDir: string;
    Tty: boolean;
    HostConfig: {
        Binds: string[];
        CapDrop: string[];
        SecurityOpt: string[];
        ReadonlyRootfs: boolean;
        Tmpfs: Record<string, string>;
        Memory: number;
        NanoCpus: number;
        PidsLimit: number;
        AutoRemove: boolean;
        NetworkMode: string;
        ExtraHosts: string[];
    };
}

/** What `inspect` returns, narrowed to what this module reads. */
export interface DockerInspect {
    State?: { Running?: boolean };
    Config?: { Labels?: Record<string, string> };
}

/** The options `logs` accepts, narrowed. */
export interface DockerLogsOptions {
    follow: boolean;
    stdout: boolean;
    stderr: boolean;
    since?: number;
}

/** The container operations this module uses. */
export interface SandboxDockerContainer {
    readonly id: string;
    start(): Promise<unknown>;
    stop(options: { t: number }): Promise<unknown>;
    remove(options: { force: boolean }): Promise<unknown>;
    inspect(): Promise<DockerInspect>;
    wait(): Promise<{ StatusCode?: number }>;
    logs(options: DockerLogsOptions): Promise<NodeJS.ReadableStream>;
}

/** One row of a container listing. */
export interface DockerContainerSummary {
    Id: string;
    State: string;
    Labels?: Record<string, string>;
    /** Creation time, in seconds since the epoch. */
    Created?: number;
}

/** The dockerode surface this module uses, narrow enough to fake. */
export interface SandboxDockerClient {
    createContainer(
        options: DockerCreateOptions,
    ): Promise<SandboxDockerContainer>;
    getContainer(id: string): SandboxDockerContainer;
    listContainers(options: {
        all: boolean;
        filters: { label: string[] };
    }): Promise<DockerContainerSummary[]>;
    modem: {
        demuxStream(
            stream: NodeJS.ReadableStream,
            stdout: NodeJS.WritableStream,
            stderr: NodeJS.WritableStream,
        ): void;
    };
}

/**
 * Builds the create request for one job.
 *
 * Exported so a unit test can assert the posture (labels, the single mount,
 * dropped capabilities, limits) as a value rather than by reaching into a
 * mock.
 *
 * @param spec - What to run and where.
 * @returns The request passed to `createContainer`.
 */
export function buildCreateOptions(spec: SandboxSpec): DockerCreateOptions {
    const target = spec.workspaceTarget ?? SANDBOX_WORKSPACE_TARGET;
    return {
        // Named so `docker ps` is readable and a leaked container says which job
        // it served; the label is the identity the reaper keys on.
        name: `jarvis-job-${spec.jobId}`,
        Image: spec.image,
        Labels: {
            [SANDBOX_MANAGED_LABEL]: SANDBOX_MANAGED_BY,
            [SANDBOX_JOB_LABEL]: spec.jobId,
        },
        Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
        Cmd: [...spec.command],
        WorkingDir: target,
        // No TTY: `logs` then yields Docker's multiplexed stream, which the
        // client demultiplexes below. A TTY would corrupt lines with carriage
        // returns and make stdout/stderr indistinguishable.
        Tty: false,
        HostConfig: {
            Binds: [`${spec.workspacePath}:${target}:rw`],
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges"],
            ReadonlyRootfs: true,
            Tmpfs: { ...DEFAULT_TMPFS, ...spec.tmpfs },
            Memory: spec.limits.memoryMb * 1024 * 1024,
            // dockerode's slice: one core is 1e9.
            NanoCpus: Math.round(spec.limits.cpus * 1_000_000_000),
            PidsLimit: spec.limits.pids,
            // The runner removes containers itself, so a crash leaves the
            // evidence the reaper needs (logs) rather than a vanished box.
            AutoRemove: false,
            NetworkMode: "bridge",
            ExtraHosts: [...(spec.extraHosts ?? DEFAULT_EXTRA_HOSTS)],
        },
    };
}

/**
 * Reads a stream as lines, tolerating multi-byte characters split across
 * chunks and the `\r` a program emits for a terminal it does not have.
 *
 * @param stream - A readable stream of text chunks.
 * @returns The stream's lines, without their terminators.
 */
async function* readLines(
    stream: NodeJS.ReadableStream,
): AsyncIterable<string> {
    let buffer = "";
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        for (;;) {
            const index = buffer.indexOf("\n");
            if (index < 0) {
                break;
            }
            yield buffer.slice(0, index).replace(/\r$/, "");
            buffer = buffer.slice(index + 1);
        }
    }
    if (buffer.length > 0) {
        yield buffer.replace(/\r$/, "");
    }
}

/**
 * The HTTP status a dockerode error carries, when it has one.
 *
 * @param err - Whatever was caught.
 * @returns The status, or `undefined` when this was not an API error.
 */
function statusOf(err: unknown): number | undefined {
    if (typeof err !== "object" || err === null) {
        return undefined;
    }
    const code = (err as { statusCode?: unknown }).statusCode;
    return typeof code === "number" ? code : undefined;
}

/**
 * Whether an error means "the container is not there" — the one condition every
 * removal treats as success, because the goal is that it is gone.
 *
 * @param err - Whatever was caught.
 * @returns True for a 404 from the daemon.
 */
function isNotFound(err: unknown): boolean {
    return statusOf(err) === 404;
}

/**
 * Whether an error means "it was already stopped" (304), which `stop` treats as
 * success for the same reason.
 *
 * @param err - Whatever was caught.
 * @returns True for a 304 from the daemon.
 */
function isNotModified(err: unknown): boolean {
    return statusOf(err) === 304;
}

/**
 * Wraps one container as the seam's handle.
 *
 * @param client - The Docker client (for log demultiplexing).
 * @param container - The container operations.
 * @returns A handle whose methods are all idempotent.
 */
function handleFor(
    client: SandboxDockerClient,
    container: SandboxDockerContainer,
): SandboxHandle {
    return {
        containerId: container.id,
        async *logs(options?: { since?: string }): AsyncIterable<string> {
            const since =
                options?.since === undefined
                    ? undefined
                    : Math.floor(Date.parse(options.since) / 1000);
            const stream = await container.logs({
                follow: true,
                stdout: true,
                stderr: true,
                ...(since !== undefined && Number.isFinite(since)
                    ? { since }
                    : {}),
            });
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            const merged = new PassThrough();
            // Pipe both demultiplexed sinks into one stream. `demuxStream`
            // writes to them but does *not* end them (docker-modem leaves that
            // to the caller), so the end is taken from the raw stream instead —
            // waiting on the sinks would never resolve and `for await` would
            // hang on a finished container.
            stdout.pipe(merged, { end: false });
            stderr.pipe(merged, { end: false });
            stream.once("end", () => merged.end());
            stream.once("error", (err: Error) => merged.destroy(err));
            client.modem.demuxStream(stream, stdout, stderr);
            yield* readLines(merged);
        },
        async wait(): Promise<SandboxExit> {
            const result = await container.wait();
            return { exitCode: result.StatusCode ?? null };
        },
        async stop(): Promise<void> {
            try {
                await container.stop({ t: STOP_GRACE_SECONDS });
            } catch (err) {
                if (!isNotFound(err) && !isNotModified(err)) {
                    throw err;
                }
            }
        },
        async remove(): Promise<void> {
            try {
                await container.stop({ t: STOP_GRACE_SECONDS });
            } catch (err) {
                if (!isNotFound(err) && !isNotModified(err)) {
                    throw err;
                }
            }
            try {
                await container.remove({ force: true });
            } catch (err) {
                if (!isNotFound(err)) {
                    throw err;
                }
            }
        },
    };
}

/**
 * Creates the Docker runner.
 *
 * @param options - `socketPath` for the daemon, or an injected `client` (tests).
 *                  Neither means `/var/run/docker.sock` on the host.
 * @returns The runner seam.
 */
export function createDockerSandbox(
    options: { socketPath?: string; client?: SandboxDockerClient } = {},
): SandboxRunner {
    const client: SandboxDockerClient =
        options.client ??
        (new Docker({
            socketPath: options.socketPath ?? DEFAULT_DOCKER_SOCKET,
        }) as unknown as SandboxDockerClient);

    return {
        async start(spec: SandboxSpec): Promise<SandboxHandle> {
            const container = await client.createContainer(
                buildCreateOptions(spec),
            );
            await container.start();
            return handleFor(client, container);
        },
        async adopt(containerId: string): Promise<SandboxHandle | null> {
            const container = client.getContainer(containerId);
            let info: DockerInspect;
            try {
                info = await container.inspect();
            } catch (err) {
                if (isNotFound(err)) {
                    return null;
                }
                throw err;
            }
            // Never adopt a container that is not ours. The reaper only passes
            // ids it listed under the managed label, but this check makes the
            // guarantee a property of the runner rather than of its caller.
            if (
                info.Config?.Labels?.[SANDBOX_MANAGED_LABEL] !==
                SANDBOX_MANAGED_BY
            ) {
                return null;
            }
            return handleFor(client, container);
        },
        async list(): Promise<SandboxContainer[]> {
            const containers = await client.listContainers({
                all: true,
                filters: {
                    label: [`${SANDBOX_MANAGED_LABEL}=${SANDBOX_MANAGED_BY}`],
                },
            });
            return containers.map((container) => ({
                containerId: container.Id,
                jobId: container.Labels?.[SANDBOX_JOB_LABEL] ?? "",
                running: container.State === "running",
                startedAt:
                    container.Created === undefined
                        ? null
                        : new Date(container.Created * 1000).toISOString(),
            }));
        },
        async remove(containerId: string): Promise<void> {
            await handleFor(client, client.getContainer(containerId)).remove();
        },
    };
}
