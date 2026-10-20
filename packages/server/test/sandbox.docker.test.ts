/**
 * Docker runner tests (#141).
 *
 * The daemon is replaced by a narrow fake, so what is asserted here is the
 * *request* — the posture that makes a job disposable and unprivileged — rather
 * than whether Docker happens to be running. The real daemon is exercised by
 * `npm run probe:sandbox` (the environment's assumptions) and, later, by the
 * end-to-end probe; this suite is the contract that the supervisor relies on.
 *
 * The two removals worth noting are both about idempotence: a reaper may try to
 * remove a container another pass already removed, and "already gone" must be
 * success, not an error that abandons the rest of the boot pass.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
    buildCreateOptions,
    createDockerSandbox,
    type DockerContainerSummary,
    type DockerCreateOptions,
    type SandboxDockerClient,
    type SandboxDockerContainer,
} from "../src/sandbox/docker";
import type { SandboxSpec } from "../src/sandbox/types";

/** A spec with every field decided, so a test changes only what it checks. */
function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
    return {
        jobId: "c1",
        image: "jarvis-job:test",
        workspacePath: "/host/jobs/c1/repo",
        command: ["opencode", "run", "do it"],
        env: { JARVIS_JOB_PROMPT: "do it", HOME: "/home/job" },
        limits: { cpus: 2, memoryMb: 4096, pids: 512, wallClockMs: 60_000 },
        ...overrides,
    };
}

/** A fake client and the calls it recorded, for assertions. */
interface FakeClient extends SandboxDockerClient {
    readonly created: DockerCreateOptions[];
    readonly started: string[];
    readonly stopped: Array<{ id: string; t: number }>;
    readonly removed: Array<{ id: string; force: boolean }>;
    readonly listQueries: Array<{ all: boolean; filters: { label: string[] } }>;
}

/**
 * Builds the fake client.
 *
 * @param options - Listing rows, inspect behaviour, and the stream `logs` returns.
 * @returns The client plus its recorded calls.
 */
function fakeClient(
    options: {
        containers?: DockerContainerSummary[];
        missing?: boolean;
        labels?: Record<string, string>;
        logStream?: NodeJS.ReadableStream;
        stopError?: unknown;
        removeError?: unknown;
    } = {},
): FakeClient {
    const created: DockerCreateOptions[] = [];
    const started: string[] = [];
    const stopped: Array<{ id: string; t: number }> = [];
    const removed: Array<{ id: string; force: boolean }> = [];
    const listQueries: Array<{
        all: boolean;
        filters: { label: string[] };
    }> = [];
    let sequence = 0;

    const container = (id: string): SandboxDockerContainer => ({
        id,
        async start(): Promise<void> {
            started.push(id);
        },
        async stop({ t }: { t: number }): Promise<void> {
            if (options.stopError !== undefined) {
                throw options.stopError;
            }
            stopped.push({ id, t });
        },
        async remove({ force }: { force: boolean }): Promise<void> {
            if (options.removeError !== undefined) {
                throw options.removeError;
            }
            removed.push({ id, force });
        },
        async inspect() {
            if (options.missing === true) {
                throw Object.assign(new Error("no such container"), {
                    statusCode: 404,
                });
            }
            return {
                Config: {
                    Labels:
                        options.labels ??
                        ({
                            "jarvis.managed": "jarvis",
                            "jarvis.job": "c1",
                        } as Record<string, string>),
                },
            };
        },
        async wait() {
            return { StatusCode: 3 };
        },
        async logs() {
            return options.logStream ?? new PassThrough();
        },
    });

    return {
        created,
        started,
        stopped,
        removed,
        listQueries,
        async createContainer(request: DockerCreateOptions) {
            created.push(request);
            sequence += 1;
            return container(`docker-${sequence}`);
        },
        getContainer(id: string) {
            return container(id);
        },
        async listContainers(query: {
            all: boolean;
            filters: { label: string[] };
        }) {
            listQueries.push(query);
            return options.containers ?? [];
        },
        modem: {
            demuxStream(stream, stdout, _stderr) {
                // The real demultiplexer only *writes* to its sinks; it does
                // not end them, which is why `logs()` watches the raw stream
                // for its end instead. Mirror that exactly — a fake that ended
                // the sinks would hide the bug this contract exists to catch.
                stream.pipe(stdout as NodeJS.WritableStream, { end: false });
            },
        },
    };
}

describe("docker sandbox request", () => {
    it("mounts only the workspace, unprivileged, bounded, with no TTY", () => {
        const options = buildCreateOptions(spec());

        expect(options).toMatchObject({
            name: "jarvis-job-c1",
            Image: "jarvis-job:test",
            WorkingDir: "/workspace",
            Tty: false,
            Cmd: ["opencode", "run", "do it"],
            Env: ["JARVIS_JOB_PROMPT=do it", "HOME=/home/job"],
            Labels: { "jarvis.managed": "jarvis", "jarvis.job": "c1" },
        });
        expect(options.HostConfig).toMatchObject({
            Binds: ["/host/jobs/c1/repo:/workspace:rw"],
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges"],
            ReadonlyRootfs: true,
            Memory: 4096 * 1024 * 1024,
            NanoCpus: 2_000_000_000,
            PidsLimit: 512,
            AutoRemove: false,
            NetworkMode: "bridge",
            ExtraHosts: ["host.docker.internal:host-gateway"],
        });
        // A read-only root still needs scratch space; a job may add more.
        expect(options.HostConfig.Tmpfs).toHaveProperty("/tmp");
    });

    it("honours a custom mount target, tmpfs, host list and network", () => {
        const options = buildCreateOptions(
            spec({
                workspaceTarget: "/repo",
                tmpfs: { "/home/job": "rw,size=64m" },
                extraHosts: [],
                network: "jarvis-sandbox",
            }),
        );

        expect(options.HostConfig.Binds).toEqual([
            "/host/jobs/c1/repo:/repo:rw",
        ]);
        expect(options.WorkingDir).toBe("/repo");
        expect(options.HostConfig.Tmpfs).toMatchObject({
            "/tmp": expect.stringContaining("size=256m"),
            "/home/job": "rw,size=64m",
        });
        expect(options.HostConfig.ExtraHosts).toEqual([]);
        // The private network the broker also sits on (#141 phase 7).
        expect(options.HostConfig.NetworkMode).toBe("jarvis-sandbox");
    });
});

describe("docker sandbox runner", () => {
    it("creates and starts the container, then hands back a handle", async () => {
        const client = fakeClient();
        const handle = await createDockerSandbox({ client }).start(spec());

        expect(handle.containerId).toBe("docker-1");
        expect(client.created).toHaveLength(1);
        expect(client.started).toEqual(["docker-1"]);
    });

    it("adopts nothing when the container is gone", async () => {
        const client = fakeClient({ missing: true });
        expect(await createDockerSandbox({ client }).adopt("gone")).toBeNull();
    });

    it("refuses to adopt a container that is not ours", async () => {
        const client = fakeClient({ labels: { "someone.else": "true" } });
        expect(
            await createDockerSandbox({ client }).adopt("foreign"),
        ).toBeNull();
    });

    it("adopts a container carrying the managed label", async () => {
        const client = fakeClient();
        const handle = await createDockerSandbox({ client }).adopt("c-live");
        expect(handle?.containerId).toBe("c-live");
    });

    it("lists only the managed fleet and maps its fields", async () => {
        const client = fakeClient({
            containers: [
                {
                    Id: "c-1",
                    State: "running",
                    Labels: { "jarvis.job": "job-a" },
                    Created: 1_700_000_000,
                },
                { Id: "c-2", State: "exited", Labels: {} },
            ],
        });

        const listed = await createDockerSandbox({ client }).list();

        expect(client.listQueries).toEqual([
            {
                all: true,
                filters: { label: ["jarvis.managed=jarvis"] },
            },
        ]);
        expect(listed).toEqual([
            {
                containerId: "c-1",
                jobId: "job-a",
                running: true,
                startedAt: new Date(1_700_000_000 * 1000).toISOString(),
            },
            {
                containerId: "c-2",
                jobId: "",
                running: false,
                startedAt: null,
            },
        ]);
    });

    it("stops and force-removes, tolerating an already-gone container", async () => {
        const client = fakeClient();
        await createDockerSandbox({ client }).remove("c-1");

        expect(client.stopped).toEqual([{ id: "c-1", t: 10 }]);
        expect(client.removed).toEqual([{ id: "c-1", force: true }]);

        const gone = fakeClient({
            removeError: Object.assign(new Error("no such container"), {
                statusCode: 404,
            }),
        });
        await expect(
            createDockerSandbox({ client: gone }).remove("c-2"),
        ).resolves.toBeUndefined();

        const stoppedAlready = fakeClient({
            stopError: Object.assign(new Error("not running"), {
                statusCode: 304,
            }),
        });
        await expect(
            createDockerSandbox({ client: stoppedAlready }).remove("c-3"),
        ).resolves.toBeUndefined();
    });

    it("streams both sinks as lines, including a split and an unterminated one", async () => {
        const stream = new PassThrough();
        const client = fakeClient({ logStream: stream });
        const handle = await createDockerSandbox({ client }).adopt("c-1");
        if (handle === null) {
            throw new Error("fixture handle missing");
        }

        const lines: string[] = [];
        const collect = (async () => {
            for await (const line of handle.logs()) {
                lines.push(line);
            }
        })();

        stream.write("first\nsecond");
        stream.write(" line\nlast");
        stream.end();

        await collect;
        expect(lines).toEqual(["first", "second line", "last"]);
    });

    it("reports the container's exit code", async () => {
        const handle = await createDockerSandbox({
            client: fakeClient(),
        }).adopt("c-1");

        expect(await handle?.wait()).toEqual({ exitCode: 3 });
    });
});
