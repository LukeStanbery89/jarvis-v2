#!/usr/bin/env node
/**
 * Runs the broker sidecar for a dev checkout (#141).
 *
 *   npm run sandbox:proxy
 *
 * Why a container even in dev: the sidecar must sit on the job's `--internal`
 * network, and a host process cannot join one (on OrbStack the network has no
 * route to the host at all). The container is a stock Node image with this
 * checkout's build mounted read-only — nothing is baked, nothing is copied.
 *
 * The script:
 *
 *   1. builds the server if `packages/server/dist` is missing;
 *   2. creates `jarvis-sandbox` as an internal network (or refuses a network
 *      of that name that has a route out);
 *   3. starts `jarvis-proxy` on the default bridge, then attaches it to the
 *      internal network — two network cards, one container;
 *   4. detaches with `--restart unless-stopped`. The container keeps running
 *      when this command (or the terminal that ran it) goes away, and Docker
 *      brings it back after a daemon or host restart; `docker logs -f
 *      jarvis-proxy` follows it, and `docker stop jarvis-proxy` stops it for
 *      good.
 *
 * Detaching is deliberate: a foreground helper is too easy to close by
 * accident, and the failure mode is a job that dies at its first model call
 * with a DNS error. The server also refuses a job when the broker does not
 * answer, so a stopped sidecar is named rather than guessed at.
 *
 * The server must point at it (`packages/server/.env`):
 *
 *   JARVIS_SANDBOX_PROXY_MODE=sidecar
 *   JARVIS_SANDBOX_PROXY_URL=http://jarvis-proxy:54322/v1
 *   JARVIS_SANDBOX_PROXY_PROBE_URL=http://127.0.0.1:54322/v1
 *   JARVIS_SANDBOX_EGRESS_PROXY_URL=http://jarvis-proxy:54323
 *   JARVIS_SANDBOX_NETWORK=jarvis-sandbox
 *   JARVIS_SANDBOX_EXTRA_HOSTS=none
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(root, "packages", "server");
const proxyEntry = path.join(serverDir, "dist", "sandbox", "proxyServer.js");
const serverEnvFile = path.join(serverDir, ".env");
const secretPath = path.join(homedir(), ".jarvis", "sandbox-proxy.key");
const networkName = "jarvis-sandbox";
const containerName = "jarvis-proxy";

/** Reads dotenv-style assignments without overriding the real environment. */
function readEnvFile(file) {
    if (!existsSync(file)) {
        return {};
    }
    const values = {};
    for (const raw of readFileSync(file, "utf8").split("\n")) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith("#")) {
            continue;
        }
        const equals = line.indexOf("=");
        if (equals <= 0) {
            continue;
        }
        const key = line.slice(0, equals).trim();
        let value = line.slice(equals + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        values[key] = value;
    }
    return values;
}

const fileEnv = readEnvFile(serverEnvFile);
const env = { ...fileEnv, ...process.env };

if (!existsSync(proxyEntry)) {
    console.log("Building the server (no dist yet)…");
    execFileSync("npm", ["run", "build", "-w", "@lukestanbery/jarvis-server"], {
        cwd: root,
        stdio: "inherit",
    });
}

if (!existsSync(secretPath)) {
    console.error(
        `No proxy secret at ${secretPath}.\n` +
            "Start the server once (with the sandbox enabled) so it creates the file, then retry.",
    );
    process.exit(1);
}

const inspect = spawnSync(
    "docker",
    ["network", "inspect", networkName, "--format", "{{.Internal}}"],
    { encoding: "utf8" },
);
if (inspect.status !== 0) {
    console.log(`Creating internal network ${networkName}…`);
    execFileSync("docker", ["network", "create", "--internal", networkName], {
        stdio: "inherit",
    });
} else if (inspect.stdout.trim() !== "true") {
    console.error(
        `${networkName} exists but is not internal, so the sidecar would not isolate anything.\n` +
            `Remove it (docker network rm ${networkName}) and retry — jobs on it must stay.`,
    );
    process.exit(1);
}

// A previous run may have left the name behind — stopped containers persist
// now that the sidecar has a restart policy, so remove it explicitly.
spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });

execFileSync(
    "docker",
    [
        "run",
        "-d",
        // Docker brings the broker back after a daemon/host restart; the
        // server's preflight still refuses jobs while it is down.
        "--restart",
        "unless-stopped",
        "--name",
        containerName,
        // The build on this machine, read-only. The workspace symlinks in
        // node_modules resolve because the logger package is mounted beside it.
        "-v",
        `${path.join(serverDir, "dist")}:/app/packages/server/dist:ro`,
        "-v",
        `${path.join(root, "packages", "logger")}:/app/packages/logger:ro`,
        "-v",
        `${path.join(root, "node_modules")}:/app/node_modules:ro`,
        "-v",
        `${secretPath}:/run/secrets/proxy.key:ro`,
        // The server runs on the host and cannot resolve the container name,
        // so the broker is published on loopback for its preflight probe. A
        // job still uses `jarvis-proxy` on the internal network.
        "-p",
        "127.0.0.1:54322:54322",
        "-e",
        "JARVIS_PROXY_SECRET_PATH=/run/secrets/proxy.key",
        "-e",
        "JARVIS_PROXY_STATUS_URL=http://host.docker.internal:54321",
        "-e",
        `JARVIS_PROXY_EGRESS_POLICY=${
            env.JARVIS_SANDBOX_EGRESS_POLICY || "public"
        }`,
        "-e",
        `JARVIS_PROXY_EGRESS_HOSTS=${env.JARVIS_SANDBOX_EGRESS_HOSTS || ""}`,
        "-e",
        `JARVIS_PROXY_UPSTREAM_BASE_URL=${
            env.JARVIS_SANDBOX_LLM_BASE_URL ||
            "https://opencode.ai/inference/openai/v1"
        }`,
        "-e",
        `JARVIS_PROXY_MODEL=${env.JARVIS_SANDBOX_MODEL || "big-pickle"}`,
        "-e",
        `JARVIS_PROXY_API_KEY=${env.JARVIS_SANDBOX_API_KEY || ""}`,
        "node:24-bookworm-slim",
        "node",
        "/app/packages/server/dist/sandbox/proxyServer.js",
    ],
    { stdio: "inherit" },
);

execFileSync("docker", ["network", "connect", networkName, containerName], {
    stdio: "inherit",
});

if (fileEnv.JARVIS_SANDBOX_PROXY_MODE?.trim().toLowerCase() === "embedded") {
    console.warn(
        "\nNote: packages/server/.env sets JARVIS_SANDBOX_PROXY_MODE=embedded.\n" +
            "The sidecar is running, but the server will keep its broker in-process and\n" +
            "jobs will use the Docker bridge (open egress). Set sidecar and restart.\n",
    );
}
if (!fileEnv.JARVIS_SANDBOX_PROXY_PROBE_URL) {
    console.warn(
        "\nNote: JARVIS_SANDBOX_PROXY_PROBE_URL is unset; the server will probe\n" +
            "JARVIS_SANDBOX_PROXY_URL (a container name it cannot resolve from the host).\n" +
            "Add JARVIS_SANDBOX_PROXY_PROBE_URL=http://127.0.0.1:54322/v1 and restart.\n",
    );
}
if (fileEnv.JARVIS_SANDBOX_NETWORK?.trim() !== networkName) {
    console.warn(
        `\nNote: JARVIS_SANDBOX_NETWORK is not ${networkName}. The script created that\n` +
            "internal network, and sidecar mode refuses jobs on a missing or routed one.\n" +
            `Set JARVIS_SANDBOX_NETWORK=${networkName} and restart.\n`,
    );
}

console.log(
    `\nSidecar running as ${containerName}.\n` +
        `  logs: docker logs -f ${containerName}\n` +
        `  stop: docker stop ${containerName}\n` +
        "It stays up when this terminal closes, and Docker restarts it after a daemon\n" +
        "or host restart; `docker stop` stops it for good. The server refuses jobs\n" +
        "while it is down.",
);
