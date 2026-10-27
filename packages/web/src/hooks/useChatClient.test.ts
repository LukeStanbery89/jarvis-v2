/**
 * The hook's wiring invariant (#122 follow-up).
 *
 * `ChatClientEvents` marks its out-of-turn callbacks optional, so forgetting to
 * pass one into the fixed `ChatClient` instance type-checks and silently drops
 * the frame. This source check pins the wiring for every out-of-turn event,
 * including the cross-device pair that made two clients disagree.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
    new URL("./useChatClient.ts", import.meta.url),
    "utf8",
);

describe("useChatClient event wiring", () => {
    it("passes every out-of-turn callback into the ChatClient", () => {
        for (const event of [
            "onNotification",
            "onSessionTitle",
            "onSessionActivity",
            "onSessionDeleted",
            "onReconnected",
        ]) {
            expect(source).toContain(`${event}:`);
        }
    });
});
