/**
 * Runs one real coding job end to end (#141).
 *
 * Every other sandbox check is a unit test or a probe of the environment; this
 * one is the whole thing: a real clone, a real container built from
 * `Dockerfile.job`, a real agent calling a real model, a settled row, a
 * notification, and a workspace with the change in it. It is the manual
 * acceptance test for the release and the fastest way to tell whether the
 * image's provider config, the mount and the token budget still line up.
 *
 * Not part of `npm test` or CI: it needs a running daemon, the job image and a
 * model endpoint. The repository it works on is a throwaway local git repo, so
 * no GitHub account and no credential are involved.
 *
 * Preconditions:
 *
 *     docker build -f Dockerfile.job -t jarvis-job:latest .     # repo root
 *     npm run build -w @lukestanbery/jarvis-server              # this package
 *
 * Usage (from `packages/server`):
 *
 *     JARVIS_SANDBOX_MODEL='qwen/qwen3-4b-2507' npm run probe:coding-job
 *
 * Options:
 *
 *     --model <id>     the model id (else JARVIS_SANDBOX_MODEL)
 *     --task "<text>"  what to tell the agent (else a small README edit)
 *     --keep           leave the workspace and database for inspection
 *
 * Exit code: 0 the job settled `ok`, 1 it did not (or the probe failed), 2 the
 * environment is unusable (no image, no model, no daemon).
 */
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);

/** Loads a built server module; the probe runs the compiled graph. */
function fromDist(relative) {
    return require(path.join(PACKAGE_ROOT, "dist", relative));
}

/** Prints usage and exits with the environment-is-unusable code. */
function usage(message) {
    console.error(message);
    console.error(
        "usage: JARVIS_SANDBOX_MODEL=<id> npm run probe:coding-job [-- --model <id>] [--task '<text>'] [--keep]",
    );
    process.exit(2);
}

const args = process.argv.slice(2);
const flag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};
const keep = args.includes("--keep");
const model = flag("--model") ?? process.env.JARVIS_SANDBOX_MODEL ?? "";
const task =
    flag("--task") ??
    'Append a line to README.md that says "Hello from the JARVIS coding sandbox." and commit the change with the message "Add sandbox greeting".';
const llmBaseUrl =
    process.env.JARVIS_SANDBOX_LLM_BASE_URL ??
    "http://host.docker.internal:1234/v1";
const image = process.env.JARVIS_SANDBOX_IMAGE ?? "jarvis-job:latest";

/**
 * The same endpoint as seen from the machine running the probe.
 *
 * `host.docker.internal` is a name containers use; it does not resolve on the
 * host, so checking reachability through it would report a healthy model as
 * down. The replacement is the same one Docker Desktop and OrbStack provide.
 *
 * @param baseUrl - The container-facing endpoint.
 * @returns The host-facing endpoint.
 */
function machineUrl(baseUrl) {
    try {
        const url = new URL(baseUrl);
        if (url.hostname === "host.docker.internal") {
            url.hostname = "localhost";
        }
        return url.toString().replace(/\/$/, "");
    } catch {
        return baseUrl;
    }
}

if (model.trim().length === 0) {
    usage(
        "no model: set JARVIS_SANDBOX_MODEL (or pass --model) to a model id the endpoint serves",
    );
}
if (!existsSync(path.join(PACKAGE_ROOT, "dist", "sandbox", "service.js"))) {
    usage(
        "dist/ is missing: run `npm run build -w @lukestanbery/jarvis-server` first",
    );
}

/** Runs a command, returning stdout; throws with its output on failure. */
function run(command, commandArgs, options = {}) {
    try {
        return execFileSync(command, commandArgs, {
            encoding: "utf8",
            ...options,
        }).trim();
    } catch (err) {
        const output = [err.stdout, err.stderr]
            .filter(Boolean)
            .join("\n")
            .trim();
        throw new Error(
            `${command} ${commandArgs[0]} failed: ${output || err.message}`,
        );
    }
}

/** A throwaway origin with one commit on `main`. */
function makeOrigin(root) {
    const dir = path.join(root, "origin");
    run("mkdir", ["-p", dir]);
    run("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(
        path.join(dir, "README.md"),
        "# Probe\n\nA scratch repository.\n",
    );
    run("git", ["add", "."], { cwd: dir });
    run(
        "git",
        [
            "-c",
            "user.name=Probe",
            "-c",
            "user.email=probe@example.invalid",
            "commit",
            "-q",
            "-m",
            "init",
        ],
        { cwd: dir },
    );
    return dir;
}

const scratch = mkdtempSync(path.join(tmpdir(), "jarvis-coding-probe-"));
const workspaceRoot = path.join(scratch, "jobs");
const dbPath = path.join(scratch, "probe.sqlite");

try {
    // 1. The environment: image, daemon and model.
    try {
        run("docker", ["image", "inspect", image]);
    } catch {
        usage(
            `the job image "${image}" is not built; run \`docker build -f Dockerfile.job -t ${image} .\` from the repository root`,
        );
    }
    let models;
    try {
        const response = await fetch(`${machineUrl(llmBaseUrl)}/models`);
        models = (await response.json()).data ?? [];
    } catch {
        usage(
            `no model endpoint at ${machineUrl(llmBaseUrl)} — start it (or set JARVIS_SANDBOX_LLM_BASE_URL)`,
        );
    }
    if (!models.some((entry) => entry.id === model)) {
        console.error(
            `note: "${model}" is not in ${llmBaseUrl}/models (${models
                .map((entry) => entry.id)
                .slice(0, 5)
                .join(", ")}); continuing anyway`,
        );
    }

    // 2. A real repository and a real database.
    const origin = makeOrigin(scratch);
    const { openAppDatabase } = require("@lukestanbery/jarvis-auth");
    const { createCodingJobService } = fromDist("sandbox/service.js");
    const { createDockerSandbox } = fromDist("sandbox/docker.js");
    const { createWorkspaceManager } = fromDist("sandbox/workspace.js");

    const store = openAppDatabase(dbPath);
    const owner = store.createUser("probe-owner", "hash", "owner");
    const service = createCodingJobService({
        ledger: store,
        runner: createDockerSandbox(),
        workspace: createWorkspaceManager({
            root: workspaceRoot,
            hostRoot: workspaceRoot,
            repos: [`file://${origin}`],
        }),
        config: {
            image,
            socketPath: "/var/run/docker.sock",
            workspaceRoot,
            workspaceHostRoot: workspaceRoot,
            maxJobs: 1,
            cpus: 2,
            memoryMb: 4096,
            pids: 512,
            // The probe is a manual check, not a long job: five minutes is
            // enough for a small repo and a small prompt.
            wallClockMs: 5 * 60 * 1000,
            repos: [`file://${origin}`],
            model,
            llmBaseUrl,
            extraHosts: ["host.docker.internal:host-gateway"],
        },
        notifications: {
            notify: async (userId, input) => {
                console.log(
                    `\n[notification] ${input.title}\n${(input.body ?? "").slice(0, 400)}`,
                );
                return {
                    notification: { id: "probe" },
                    delivered: 0,
                    suppressed: "absent",
                };
            },
        },
    });

    // 3. Start it and wait — the probe is the owner who *does* wait.
    console.log(`starting a coding job (model ${model}, image ${image})…`);
    const started = await service.start({
        userId: owner.id,
        repo: `file://${origin}`,
        task,
        crashPolicy: "prune",
    });
    if (!started.ok) {
        console.error(`refused: ${started.code} — ${started.reason}`);
        process.exitCode = 2;
    } else {
        console.log(`job ${started.job.id} on ${started.job.branch}`);
        const budget = setTimeout(
            () => {
                console.error("\nprobe timed out after 10 minutes");
                process.exitCode = 1;
            },
            10 * 60 * 1000,
        );
        budget.unref?.();
        await started.done;
        clearTimeout(budget);

        const row = store.getCodingJobById(started.job.id);
        console.log(`\nstate: ${row.state}`);
        if (row.lastError) {
            console.log(`error: ${row.lastError}`);
        }
        console.log(`branch: ${row.branch}`);
        console.log(`workspace: ${row.workspacePath}`);
        console.log(`diff summary:\n${row.diffSummary || "(none)"}`);
        console.log(`log tail:\n${(row.logTail || "(none)").slice(-1500)}`);

        if (row.state !== "ok") {
            process.exitCode = 1;
        } else {
            // The workspace is the artifact: prove the change is in it.
            const log = run("git", [
                "-C",
                row.workspacePath,
                "log",
                "--oneline",
                "-3",
            ]);
            const status = run("git", [
                "-C",
                row.workspacePath,
                "status",
                "--porcelain",
            ]);
            console.log(`\ngit log:\n${log}`);
            console.log(
                `working tree: ${status.length === 0 ? "clean" : status}`,
            );
            const readme = readFileSync(
                path.join(row.workspacePath, "README.md"),
                "utf8",
            );
            console.log(`README.md:\n${readme}`);
        }
    }
} catch (err) {
    console.error(
        `\nprobe failed: ${err instanceof Error ? err.stack : String(err)}`,
    );
    process.exitCode = 1;
} finally {
    if (keep) {
        console.log(`\nkept: ${scratch}`);
    } else {
        rmSync(scratch, { recursive: true, force: true });
    }
}
