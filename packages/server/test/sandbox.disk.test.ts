/**
 * Workspace measurement (#141).
 *
 * The quota watchdog depends on `du` reading a real tree; a fake would only
 * prove the service calls the function. These use a temp directory with a
 * known-size file, and the failure case (a path that is gone) must read as
 * zero so a broken measurement cannot kill a healthy job.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceBytes } from "../src/sandbox/disk";

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("workspaceBytes", () => {
    it("counts the tree's allocated kilobytes", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-du-"));
        dirs.push(dir);
        writeFileSync(path.join(dir, "blob"), Buffer.alloc(512 * 1024, 1));

        const bytes = await workspaceBytes(dir);

        expect(bytes).toBeGreaterThanOrEqual(512 * 1024);
        expect(bytes).toBeLessThan(2 * 1024 * 1024);
    });

    it("reads a missing tree as zero rather than throwing", async () => {
        expect(
            await workspaceBytes(
                path.join(tmpdir(), "jarvis-du-does-not-exist"),
            ),
        ).toBe(0);
    });
});
