/**
 * Probes the container assumptions behind the sandbox (#141).
 *
 * The sandbox plan rests on three facts about the Docker daemon, and none of
 * them is a property of our code, so a unit test cannot settle them: they
 * depend on the engine, the host OS, and where JARVIS itself runs.
 *
 * 1. **A bind mount is resolved on the host.** A sibling container is handed a
 *    workspace path by the server, and the daemon resolves that path on *its*
 *    filesystem, not the server's. The failure mode is silent rather than
 *    loud — mounting a path that exists only inside a container creates an
 *    empty directory on the host instead of erroring — which is why the plan
 *    carries a separate `JARVIS_SANDBOX_WORKSPACE_HOST_ROOT`. The observation
 *    is printed either way; the gating assertion is that a file written inside
 *    the container appears at the host path the server would read.
 *
 * 2. **A job container can reach its model.** The host LLM listens at
 *    `host.docker.internal:1234`, and a second container cannot assume that
 *    name resolves: OrbStack and Docker Desktop provide it, plain Docker
 *    Engine on Linux needs `--add-host host.docker.internal:host-gateway`.
 *    Both spellings are tried, native first, and the one that worked is
 *    reported — that is the value the runner's own flags will copy. Skipped
 *    when the model is unreachable from the *host* as well (nothing to probe),
 *    failed when it is reachable from the host but not from a container.
 *
 * 3. **A container left by a dead process is findable, readable and
 *    removable.** The boot reaper keys off labels (`jarvis.managed` +
 *    `jarvis.job`), so a container started by a process that never cleaned up
 *    must be discoverable by filter, inspectable, readable (the adopt path),
 *    removable (the prune path), and absent afterwards. It also asserts the
 *    `jarvis` server container itself is *not* in the managed set — a reaper
 *    that could take its own server down is the bug this checks for.
 *
 * The `docker` CLI is used on purpose rather than the `dockerode` client the
 * runner will use: this probes the environment, not our implementation, and a
 * probe that broke when our client changed would be measuring the wrong thing.
 *
 * Maintenance tool, not part of `npm test` or CI: it needs a running daemon,
 * pulls `alpine:3` if it is missing, and starts short-lived containers of its
 * own (all labelled `jarvis.probeRun=<run id>` and removed on the way out).
 *
 * Usage (from `packages/server`):
 *
 *     npm run probe:sandbox
 *
 * Exit code: 0 every gating assertion held, 1 one failed, 2 the environment
 * was unusable (no daemon, or the whole probe exceeded its 3-minute budget).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** The throwaway image the probe runs (tiny, already common, has `sh`). */
const IMAGE = process.env.JARVIS_PROBE_IMAGE ?? "alpine:3";
/** The host LLM the sandbox must reach from inside a job container. */
const HOST_LLM =
    process.env.JARVIS_PROBE_LLM ?? "http://host.docker.internal:1234";
/**
 * The same LLM as seen from the machine running the probe.
 *
 * Separate from {@link HOST_LLM} because `host.docker.internal` is a name
 * *containers* use: it does not resolve on the host itself, so probing
 * reachability through it would report a healthy model as down.
 */
const MACHINE_LLM =
    process.env.JARVIS_PROBE_LLM_HOST ?? "http://localhost:1234";
/** The label that marks a container as belonging to JARVIS's own fleet. */
const MANAGED_LABEL = "jarvis.managed=jarvis";
/** Budget for the whole probe, so a wedged daemon cannot hang a terminal. */
const PROBE_BUDGET_MS = 180_000;

const runId = `${Date.now()}-${process.pid}`;
/** Run-scoped label: every container this run starts carries it. */
const RUN_LABEL = `jarvis.probeRun=${runId}`;

/** What one assertion reported, in the order it was checked. */
const results = [];

/**
 * Records a gating assertion. Only `pass`/`fail` decide the exit code —
 * `note` is an observation and `skip` is an assertion that could not run.
 *
 * @param state - `pass`, `fail`, `note` or `skip`.
 * @param name - One-line statement of what was checked.
 * @param [detail] - What was actually observed.
 */
function record(state, name, detail) {
    results.push({ state, name, detail });
    const mark = {
        pass: "[PASS]",
        fail: "[FAIL]",
        note: "[note]",
        skip: "[SKIP]",
    }[state];
    console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Runs `docker` with the given arguments and returns trimmed stdout.
 *
 * A non-zero exit is rethrown with the command's own output attached, so an
 * assertion failure reads as what Docker said rather than as `exit 1`.
 *
 * @param args - Arguments passed to `docker` verbatim (never through a shell).
 * @returns The command's stdout, whitespace-trimmed.
 */
async function docker(args) {
    try {
        const { stdout } = await execFileAsync("docker", args, {
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout.trim();
    } catch (err) {
        const output = [err.stdout, err.stderr]
            .filter(
                (part) => typeof part === "string" && part.trim().length > 0,
            )
            .join("\n")
            .trim();
        throw new Error(`docker ${args[0]} failed: ${output || err.message}`);
    }
}

/**
 * Whether `text` parses as the OpenAI-style model list the LLM serves.
 *
 * @param text - A candidate response body.
 * @returns True when it is JSON carrying a `data` array.
 */
function looksLikeModels(text) {
    if (!text) {
        return false;
    }
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed?.data);
    } catch {
        return false;
    }
}

/** Containers this run started and must remove, whatever happens. */
const started = [];

/**
 * Removes everything the probe started, tolerating an already-gone container.
 *
 * @returns A list of cleanup problems, empty when all was well.
 */
async function cleanup() {
    const problems = [];
    for (const id of started) {
        try {
            await docker(["rm", "-f", id]);
        } catch (err) {
            problems.push(err.message);
        }
    }
    started.length = 0;
    try {
        const leftovers = await docker([
            "ps",
            "-aq",
            "--filter",
            `label=${RUN_LABEL}`,
        ]);
        for (const id of leftovers.split("\n").filter(Boolean)) {
            await docker(["rm", "-f", id]);
        }
    } catch (err) {
        problems.push(err.message);
    }
    return problems;
}

/**
 * Assertion 0: the daemon answers at all, and a CLI exists to ask it.
 *
 * @returns True when the probe may continue.
 */
async function checkDaemon() {
    try {
        const version = await docker([
            "version",
            "--format",
            "{{.Server.Version}}",
        ]);
        record("note", "docker daemon reachable", `server ${version}`);
        return true;
    } catch (err) {
        if (
            err.message.includes("ENOENT") ||
            err.message.includes("spawn docker")
        ) {
            record(
                "fail",
                "docker CLI available",
                "docker is not on PATH — install it (or OrbStack/Docker Desktop) and retry",
            );
        } else {
            record("fail", "docker daemon reachable", err.message);
        }
        return false;
    }
}

/**
 * Assertion 1: a bind mount written inside a container lands at the host path
 * the server would read — plus the silent-failure observation that motivates
 * `JARVIS_SANDBOX_WORKSPACE_HOST_ROOT`.
 *
 * @returns Nothing; records its own results.
 */
async function checkBindMount() {
    const hostDir = mkdtempSync(path.join(tmpdir(), "jarvis-sandbox-probe-"));
    try {
        writeFileSync(path.join(hostDir, "host.txt"), "from-host\n");
        await docker([
            "run",
            "--rm",
            "--label",
            RUN_LABEL,
            "-v",
            `${hostDir}:/probe:rw`,
            IMAGE,
            "sh",
            "-c",
            "cat /probe/host.txt > /probe/read.txt && echo from-container > /probe/container.txt",
        ]);
        const readBack = readFileSync(
            path.join(hostDir, "read.txt"),
            "utf8",
        ).trim();
        const written = readFileSync(
            path.join(hostDir, "container.txt"),
            "utf8",
        ).trim();
        if (readBack === "from-host" && written === "from-container") {
            record(
                "pass",
                "bind mount is visible on the host path the server reads",
                `${hostDir} ↔ /probe`,
            );
        } else {
            record(
                "fail",
                "bind mount is visible on the host path the server reads",
                `host read ${JSON.stringify(readBack)}, container wrote ${JSON.stringify(written)}`,
            );
        }
    } catch (err) {
        record("fail", "bind mount round-trip", err.message);
    } finally {
        try {
            rmSync(hostDir, { recursive: true, force: true });
        } catch {
            // A best-effort sweep; a leftover temp dir is not a failed probe.
        }
    }

    // The trap, observed rather than asserted: a path that exists only inside
    // a container must not be usable as the mount source. Whatever the engine
    // does here — create an empty host dir, or refuse — is reported, because
    // both outcomes are why the host root is a separate configuration value.
    const ghostParent = mkdtempSync(
        path.join(tmpdir(), "jarvis-sandbox-ghost-"),
    );
    const ghost = path.join(ghostParent, "missing", "workspace");
    try {
        await docker([
            "run",
            "--rm",
            "--label",
            RUN_LABEL,
            "-v",
            `${ghost}:/probe:rw`,
            IMAGE,
            "sh",
            "-c",
            "ls -A /probe",
        ]);
        record(
            "note",
            "mount source that exists only inside a container",
            existsSync(ghost)
                ? "the engine silently created an empty host directory instead of erroring — the trap JARVIS_SANDBOX_WORKSPACE_HOST_ROOT avoids"
                : "the engine reported success without creating the host path",
        );
    } catch (err) {
        record(
            "note",
            "mount source that exists only inside a container",
            `the engine refused the path: ${err.message}`,
        );
    } finally {
        try {
            rmSync(ghostParent, { recursive: true, force: true });
        } catch {
            // Root-owned leftovers, if any, are noted above by the observation
            // itself; this is a temp dir and does not gate the probe.
        }
    }
}

/**
 * Docker's short-form id (12 chars), the spelling `ps -q` returns.
 *
 * `docker run -d` answers with the full 64-char id while `ps -q` truncates,
 * so identity checks must compare the short form or they fail on two spellings
 * of the same container.
 *
 * @param id - A container id in either form.
 * @returns Its first 12 characters.
 */
function shortId(id) {
    return id.slice(0, 12);
}

/**
 * Assertion 2: a job container can reach the host LLM, trying the native
 * `host.docker.internal` spelling first and `--add-host host-gateway` second.
 *
 * @returns Nothing; records its own results (a skip when the model is down).
 */
async function checkModelReach() {
    let hostUp = false;
    try {
        const res = await fetch(`${MACHINE_LLM}/v1/models`, {
            signal: AbortSignal.timeout(3000),
        });
        hostUp = res.ok;
    } catch {
        hostUp = false;
    }
    if (!hostUp) {
        record(
            "skip",
            "job container can reach its model",
            `${MACHINE_LLM}/v1/models does not answer from this machine either — start the LLM and re-run`,
        );
        return;
    }

    const probe = `wget -qO- -T 5 ${HOST_LLM}/v1/models`;
    const spellings = [
        { name: "native host.docker.internal", args: [] },
        {
            name: "add-host host-gateway",
            args: ["--add-host", "host.docker.internal:host-gateway"],
        },
    ];
    for (const { name, args } of spellings) {
        try {
            const out = await docker([
                "run",
                "--rm",
                "--label",
                RUN_LABEL,
                ...args,
                IMAGE,
                "sh",
                "-c",
                probe,
            ]);
            if (looksLikeModels(out)) {
                const ids = JSON.parse(out).data.map((m) => m.id);
                record(
                    "pass",
                    "job container can reach its model",
                    `${name}; ${ids.length} model(s) visible (e.g. ${ids[0] ?? "none"})`,
                );
                return;
            }
        } catch {
            // Fall through to the next spelling.
        }
    }
    record(
        "fail",
        "job container can reach its model",
        `the host answers but neither spelling resolves from a container — the runner would have no model`,
    );
}

/**
 * Assertion 3: a labelled container left by a "crashed" run is discoverable,
 * inspectable, readable (adopt), removable (prune), and absent afterwards —
 * and the server's own container is not in the managed set.
 *
 * @returns Nothing; records its own results.
 */
async function checkOrphanHandling() {
    const jobLabel = `jarvis.job=probe-${runId}-orphan`;
    let containerId = "";
    try {
        containerId = (
            await docker([
                "run",
                "-d",
                "--label",
                MANAGED_LABEL,
                "--label",
                jobLabel,
                "--label",
                RUN_LABEL,
                IMAGE,
                "sh",
                "-c",
                "echo booted; exec sleep 300",
            ])
        ).trim();
        started.push(containerId);

        // Discover: exactly the filter the reaper will run at boot.
        const found = await docker([
            "ps",
            "-q",
            "--filter",
            `label=${jobLabel}`,
        ]);
        if (found === shortId(containerId)) {
            record(
                "pass",
                "orphan discovered by label",
                `${jobLabel} → ${shortId(containerId)}`,
            );
        } else {
            record(
                "fail",
                "orphan discovered by label",
                `expected ${shortId(containerId)}, filter returned ${found || "nothing"}`,
            );
            return;
        }

        // Reap-safety: the managed set must never contain the server itself.
        let serverId = "";
        try {
            serverId = await docker([
                "inspect",
                "--format",
                "{{.Id}}",
                "jarvis",
            ]);
        } catch {
            serverId = ""; // No running server container on this host.
        }
        const managed = await docker([
            "ps",
            "-q",
            "--filter",
            `label=${MANAGED_LABEL}`,
        ]);
        const managedIds = managed.split("\n").filter(Boolean);
        if (serverId === "" || !managedIds.includes(shortId(serverId))) {
            record(
                "pass",
                "the reaper's managed set excludes the server container",
                serverId === ""
                    ? "no `jarvis` container on this host"
                    : `${managedIds.length} managed, none of them \`jarvis\``,
            );
        } else {
            record(
                "fail",
                "the reaper's managed set excludes the server container",
                "the server container carries jarvis.managed=jarvis",
            );
        }

        // Adopt: state and log stream are readable after the "crash".
        const state = JSON.parse(
            await docker([
                "inspect",
                "--format",
                "{{json .State}}",
                containerId,
            ]),
        );
        const logs = await docker(["logs", containerId]);
        if (state.Running && logs.includes("booted")) {
            record(
                "pass",
                "adopt path: state and logs readable after the crash",
                `running=${state.Running}, log tail contains "booted"`,
            );
        } else {
            record(
                "fail",
                "adopt path: state and logs readable after the crash",
                `running=${state.Running}, logs=${JSON.stringify(logs.slice(0, 80))}`,
            );
        }

        // Prune: remove, then the same filter must come back empty.
        await docker(["rm", "-f", containerId]);
        const gone = await docker([
            "ps",
            "-aq",
            "--filter",
            `label=${jobLabel}`,
        ]);
        if (gone === "") {
            record("pass", "prune path: container gone and no longer listed");
        } else {
            record(
                "fail",
                "prune path: container gone and no longer listed",
                `${gone} still listed after rm -f`,
            );
        }
    } catch (err) {
        record("fail", "orphan handling", err.message);
    }
}

/** Prints the tally and maps it to the documented exit codes. */
function finish() {
    const counts = results.reduce(
        (acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }),
        {},
    );
    console.log(
        `\nsandbox probe: ${counts.pass ?? 0} passed, ${counts.fail ?? 0} failed, ${
            counts.skip ?? 0
        } skipped, ${counts.note ?? 0} noted`,
    );
    if ((counts.fail ?? 0) > 0) {
        process.exitCode = 1;
    }
}

const budget = setTimeout(() => {
    console.error(
        "\nsandbox probe: exceeded its 3-minute budget — daemon wedged?",
    );
    process.exit(2);
}, PROBE_BUDGET_MS);

try {
    if (await checkDaemon()) {
        await docker(["image", "inspect", IMAGE]).catch(async () => {
            console.log(`pulling ${IMAGE} …`);
            await docker(["pull", IMAGE]);
        });
        await checkBindMount();
        await checkModelReach();
        await checkOrphanHandling();
    }
} catch (err) {
    record("fail", "probe aborted", err.message);
} finally {
    clearTimeout(budget);
    const problems = await cleanup();
    if (problems.length > 0) {
        record("note", "cleanup reported problems", problems.join("; "));
    }
    finish();
}
