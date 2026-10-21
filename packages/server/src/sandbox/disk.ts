/**
 * How much disk a job's workspace is using (#141).
 *
 * The clone is a **bind mount**, so Docker cannot apply a storage quota to it:
 * the filesystem sees whatever the agent writes. The supervisor therefore
 * samples the tree while the job runs and stops the container when it crosses
 * `JARVIS_SANDBOX_MAX_WORKSPACE_MB` — a runaway `npm install` or a large
 * generated asset must fail the job, not fill the laptop.
 *
 * `du -sk` is the whole implementation: portable across the macOS and Linux
 * hosts the server runs on, and it reads allocated blocks rather than apparent
 * size. A failed measurement returns zero — the quota is a guard, and a guard
 * that fails must not kill a healthy job.
 */
// sandbox e2e probe
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Measures one workspace's size.
 *
 * @param workspacePath - The server-side clone path.
 * @returns Bytes in use, or `0` when the tree cannot be measured.
 */
export async function workspaceBytes(workspacePath: string): Promise<number> {
    try {
        const { stdout } = await execFileAsync("du", ["-sk", workspacePath], {
            maxBuffer: 1024 * 1024,
        });
        const kib = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
        return Number.isFinite(kib) && kib > 0 ? kib * 1024 : 0;
    } catch {
        return 0;
    }
}
