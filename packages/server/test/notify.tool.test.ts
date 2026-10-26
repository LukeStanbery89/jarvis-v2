/**
 * Tests for the `sendNotification` tool (#139): the guest refusal, the fixed
 * `kind`, the model-facing text for every delivery outcome, and the
 * cancelled-turn path.
 *
 * The service is a fake. Which notifications get pushed, and why, is the
 * *service's* subject (`notifications.test.ts`); this suite is only about what
 * the model is told and what it is allowed to ask for.
 */
import { describe, expect, it } from "vitest";
import {
    AGENT_NOTIFICATION_KIND,
    createNotifyTool,
    formatNotifyOutcome,
} from "../src/llm/tools/notify";
import { NotificationInputError } from "../src/notify/types";
import type { NotificationInput, NotifyOutcome } from "../src/notify/types";
import type { NotificationService } from "../src/notify/service";
import type { AppNotification } from "@lukestanbery/jarvis-auth";

/** A persisted record as the store would hand it back. */
const RECORD: AppNotification = {
    id: "n1",
    userId: 7,
    kind: AGENT_NOTIFICATION_KIND,
    class: "notification",
    priority: "normal",
    title: "Research is ready",
    body: null,
    state: "pending",
    requiresAnswer: false,
    dedupeKey: null,
    answer: null,
    jobId: null,
    codingJobId: null,
    targetDeviceId: null,
    createdAt: "2026-10-16T12:00:00.000Z",
    deliveredAt: null,
    settledAt: null,
};

const OWNER = {
    configurable: { sessionId: "s1", clientIp: "10.0.0.1", userId: 7 },
};
const GUEST = { configurable: { sessionId: "s1", clientIp: "10.0.0.1" } };

/** A scripted service recording what the tool asked for; throws on script. */
function fakeService(script: NotifyOutcome | Error): {
    service: NotificationService;
    calls: { userId: number; input: NotificationInput }[];
} {
    const calls: { userId: number; input: NotificationInput }[] = [];
    const service = {
        async notify(userId: number, input: NotificationInput) {
            calls.push({ userId, input });
            if (script instanceof Error) {
                throw script;
            }
            return script;
        },
    } as unknown as NotificationService;
    return { calls, service };
}

/** Invokes the tool the way the graph does, with the runtime it stamps. */
async function invoke(
    service: NotificationService,
    args: {
        title: string;
        body?: string;
        priority?: "low" | "normal" | "high";
    },
    runtime: {
        configurable?: Record<string, unknown>;
        signal?: AbortSignal;
    } = OWNER,
): Promise<string> {
    return (await createNotifyTool({ service }).invoke(
        args,
        runtime,
    )) as string;
}

describe("formatNotifyOutcome", () => {
    it("says how many connected clients received it", () => {
        expect(
            formatNotifyOutcome({
                notification: RECORD,
                delivered: 1,
                suppressed: null,
            }),
        ).toBe("Delivered to 1 connected client.");
        expect(
            formatNotifyOutcome({
                notification: RECORD,
                delivered: 3,
                suppressed: null,
            }),
        ).toBe("Delivered to 3 connected clients.");
    });

    it("names the reason it was not pushed, and where it is waiting", () => {
        const cases: Array<[NotifyOutcome["suppressed"], string]> = [
            ["disabled", "notifications switched off"],
            ["quiet-hours", "quiet hours"],
            ["absent", "no client of theirs is connected"],
            ["cap", "budget"],
        ];
        for (const [reason, phrase] of cases) {
            const text = formatNotifyOutcome({
                notification: RECORD,
                delivered: 0,
                suppressed: reason,
            });
            expect(text).toContain("not pushed");
            expect(text).toContain(phrase);
            // The point of the whole sentence: the model must say where it is,
            // not that it appeared.
            expect(text).toContain("waiting there");
        }
    });

    it("never claims delivery when no reason was recorded", () => {
        const text = formatNotifyOutcome({
            notification: RECORD,
            delivered: 0,
            suppressed: null,
        });
        expect(text).toContain("not pushed to a live client");
        expect(text).not.toContain("Delivered");
    });
});

describe("sendNotification tool", () => {
    it("records under the fixed agent kind, with the model's words", async () => {
        const fake = fakeService({
            notification: RECORD,
            delivered: 1,
            suppressed: null,
        });
        const text = await invoke(fake.service, {
            title: "Research is ready",
            body: "The model archive finished downloading.",
            priority: "high",
        });

        expect(fake.calls).toEqual([
            {
                userId: 7,
                input: {
                    kind: AGENT_NOTIFICATION_KIND,
                    title: "Research is ready",
                    body: "The model archive finished downloading.",
                    priority: "high",
                },
            },
        ]);
        expect(text).toBe("Delivered to 1 connected client.");
    });

    it("omits an empty body and an unchosen priority", async () => {
        const fake = fakeService({
            notification: RECORD,
            delivered: 0,
            suppressed: "absent",
        });
        await invoke(fake.service, { title: "Still working", body: "" });

        // Both are absent, not empty: the service supplies its own default
        // priority, and the store must not hold two spellings of "nothing".
        expect(fake.calls[0]?.input).toEqual({
            kind: AGENT_NOTIFICATION_KIND,
            title: "Still working",
        });
    });

    it("refuses a guest without reaching the service", async () => {
        const fake = fakeService({
            notification: RECORD,
            delivered: 1,
            suppressed: null,
        });
        const text = await invoke(fake.service, { title: "Hello" }, GUEST);

        // A notification is addressed to an account; a guest has none. The
        // wording is the shared sign-in refusal the metered tools use.
        expect(text).toContain("requires signing in");
        expect(fake.calls).toEqual([]);
    });

    it("hands a rejected argument back to the model to fix", async () => {
        const fake = fakeService(
            new NotificationInputError("title must be at most 120 characters"),
        );
        const text = await invoke(fake.service, { title: "x".repeat(500) });

        expect(text).toContain("not sent");
        expect(text).toContain("at most 120 characters");
        expect(text).toContain("call again");
    });

    it("degrades an unexpected failure to text rather than a broken turn", async () => {
        const fake = fakeService(new Error("database is locked"));
        const text = await invoke(fake.service, { title: "Hello" });

        expect(text).toContain("could not be sent");
        expect(text).not.toContain("database is locked");
    });

    it("rejects a cancelled turn instead of reporting a failure", async () => {
        const fake = fakeService(new Error("database is locked"));
        await expect(
            invoke(fake.service, { title: "Hello" }, {
                ...OWNER,
                signal: AbortSignal.abort(),
            } as {
                configurable?: Record<string, unknown>;
                signal?: AbortSignal;
            }),
        ).rejects.toThrow();
    });
});
