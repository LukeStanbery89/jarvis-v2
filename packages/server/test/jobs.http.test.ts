/**
 * Jobs REST tests (#90 phase 5): `/api/jobs` over supertest.
 *
 * The policy itself is covered at its own seam (`jobs.create.test.ts`), and the
 * tools keep theirs (`jobs.tool.test.ts`). What is only visible here is the
 * translation: which refusal becomes which status, that a job id belonging to
 * another account is a 404 rather than a 403, that the routes mount only when
 * the scheduler is wired, and that a page can do the whole round trip — create,
 * see it, snooze it, cancel it, read what the runs did.
 *
 * The clock is fixed, so "ten minutes from now" is a real instant the test can
 * assert against, and the creator is built over the same store the routes read.
 */
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { generateDeviceToken } from "@lukestanbery/jarvis-auth";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import { createApp } from "../src/app";
import { getAppConfig } from "../src/config";
import type { AppConfig } from "../src/config";
import { createJobCreator } from "../src/scheduler/create";
import type { JobCreator } from "../src/scheduler/create";
import { createNotificationHub } from "../src/notify/hub";
import { createInAppChannel } from "../src/notify/channels/inApp";
import { createNotificationService } from "../src/notify/service";
import type { NotificationService } from "../src/notify/service";
import {
    NOTIFY_ENABLED_PREF,
    NOTIFY_QUIET_HOURS_PREF,
} from "../src/notify/prefs";

/** Thursday 2026-01-01 19:05 local, the instant every test creates against. */
const NOW = new Date(2026, 0, 1, 19, 5, 0, 0);

/** `NOW` plus `minutes`, as the ISO instant a page's picker would send. */
function iso(minutes: number): string {
    return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

describe("jobs routes (#90 phase 5)", () => {
    let store: AppDatabase;
    let creator: JobCreator;
    let token: string;
    let userId: number;
    let appConfig: AppConfig;

    beforeEach(() => {
        store = createInMemoryAppDatabase();
        userId = store.createUser("luke", "hash", "owner").id;
        let idSeq = 0;
        creator = createJobCreator({
            ledger: store,
            maxPerUser: 3,
            maxHorizonMs: 30 * 86_400_000,
            now: () => NOW,
            newId: () => `job-${(idSeq += 1)}`,
        });
        // A device token is stored as a hash: the middleware hashes the
        // presented bearer and resolves it, so the raw secret never reaches the
        // database (or this test's fixtures).
        const material = generateDeviceToken();
        token = material.token;
        store.createDevice(
            userId,
            "web-test",
            material.tokenHash,
            material.prefix,
        );
        appConfig = getAppConfig();
    });

    /**
     * The app under test, with both surfaces wired.
     *
     * Notifications are part of the fixture because the two are mounted
     * together in a real deployment, and the link between them (a job's
     * announcement naming its job) is only visible across the pair.
     */
    const buildApp = (jobs: JobCreator | null = creator) => {
        const hub = createNotificationHub();
        const notifications: NotificationService = createNotificationService({
            store,
            hub,
            channels: [createInAppChannel(hub)],
            maxPerUser: 200,
            deliveriesPerWindow: 20,
            now: () => NOW,
        });
        return createApp(
            store,
            appConfig,
            undefined,
            undefined,
            notifications,
            jobs ?? undefined,
        );
    };

    /** Schedules a timer ten minutes out and returns the created job's id. */
    async function createTimer(
        body: Record<string, unknown> = {},
    ): Promise<string> {
        const created = await request(buildApp())
            .post("/api/jobs")
            .set("authorization", `Bearer ${token}`)
            .send({ label: "Kettle", class: "timer", runAt: iso(10), ...body })
            .expect(201);
        return created.body.job.id as string;
    }

    it("refuses an unauthenticated caller", async () => {
        await request(buildApp()).get("/api/jobs").expect(401);
        await request(buildApp())
            .post("/api/jobs")
            .send({ label: "Kettle", class: "timer", runAt: iso(10) })
            .expect(401);
    });

    it("mounts nothing at all when the scheduler is not wired", async () => {
        // Not a 401 and not a 404 from the router: no route exists, which is the
        // same posture as `JARVIS_NOTIFY=off` on the notification surface.
        await request(buildApp(null))
            .get("/api/jobs")
            .set("authorization", `Bearer ${token}`)
            .expect(404);
    });

    it("creates a message job, and says what quiet hours will do with it", async () => {
        const created = await request(buildApp())
            .post("/api/jobs")
            .set("authorization", `Bearer ${token}`)
            .send({
                label: "Kettle",
                class: "timer",
                message: "Take the kettle off the heat.",
                runAt: iso(10),
            })
            .expect(201);

        expect(created.body.job).toMatchObject({
            label: "Kettle",
            class: "timer",
            // A page-created job is always a message job: text with nothing to
            // run is what a timer or reminder needs.
            kind: "message",
            message: "Take the kettle off the heat.",
            state: "pending",
            attempts: 0,
            runAt: iso(10),
        });
        expect(created.body.job.id).toBe("job-1");
        // No quiet hours set: nothing will hold it.
        expect(created.body.quiet).toEqual({ state: "clear" });

        const listed = await request(buildApp())
            .get("/api/jobs")
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(listed.body.jobs).toHaveLength(1);
        expect(listed.body.jobs[0].id).toBe("job-1");

        const detail = await request(buildApp())
            .get("/api/jobs/job-1")
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(detail.body.job.id).toBe("job-1");
        // Nothing has run yet, so the history is an empty list rather than a
        // missing key: the shape does not depend on whether it has fired.
        expect(detail.body.runs).toEqual([]);
    });

    it("falls back to the label when no message is given", async () => {
        const created = await request(buildApp())
            .post("/api/jobs")
            .set("authorization", `Bearer ${token}`)
            .send({ label: "Call Mum", class: "reminder", runAt: iso(60) })
            .expect(201);

        expect(created.body.job.message).toBe("Call Mum");
    });

    it("predicts the quiet hours a reminder will wait out", async () => {
        store.setPrefs(userId, [
            {
                key: NOTIFY_QUIET_HOURS_PREF,
                value: { start: "19:00", end: "07:00" },
            },
        ]);

        const created = await request(buildApp())
            .post("/api/jobs")
            .set("authorization", `Bearer ${token}`)
            .send({ label: "Call Mum", class: "reminder", runAt: iso(10) })
            .expect(201);

        // 19:15 is inside the window, so the reminder will not run then — it
        // moves to the moment the window closes. The prediction says so without
        // pre-deferring: the runner reads the prefs again when it fires.
        expect(created.body.quiet.state).toBe("held");
        expect(created.body.quiet.window).toBe("7:00 PM–7:00 AM");
        expect(new Date(created.body.quiet.until).getHours()).toBe(7);
        expect(store.getJob(userId, created.body.job.id)?.runAt).toBe(iso(10));
    });

    it("says when notifications are switched off rather than predicting quiet hours", async () => {
        store.setPrefs(userId, [{ key: NOTIFY_ENABLED_PREF, value: false }]);

        const created = await request(buildApp())
            .post("/api/jobs")
            .set("authorization", `Bearer ${token}`)
            .send({ label: "Call Mum", class: "reminder", runAt: iso(10) })
            .expect(201);

        // The job is still stored and will still run: the switch silences the
        // announcement, not the work.
        expect(created.body.quiet).toEqual({ state: "disabled" });
    });

    it("refuses what it cannot honour, each with the status that says why", async () => {
        const post = (body: Record<string, unknown>) =>
            request(buildApp())
                .post("/api/jobs")
                .set("authorization", `Bearer ${token}`)
                .send(body);

        // A moment that has passed, and a timer a day out: both are about the
        // request, so both are 400s.
        await post({
            label: "Kettle",
            class: "timer",
            runAt: iso(-1),
        }).expect(400);
        await post({
            label: "Kettle",
            class: "timer",
            runAt: iso(26 * 60),
        }).expect(400);
        await post({
            label: "Kettle",
            class: "timer",
            runAt: iso(31 * 24 * 60),
        }).expect(400);
        await post({ label: "", class: "timer", runAt: iso(10) }).expect(400);
        await post({ label: "Kettle", class: "timer" }).expect(400);
        expect(store.listJobs(userId)).toEqual([]);

        // The queue being full is about the account, not the request: 409.
        await createTimer();
        await createTimer();
        await createTimer();
        const full = await post({
            label: "Kettle",
            class: "timer",
            runAt: iso(10),
        }).expect(409);
        expect(full.body.error).toContain("cancel one");
        expect(store.listJobs(userId)).toHaveLength(3);
    });

    it("lists settled jobs only when asked, and pages the list", async () => {
        const first = await createTimer();
        await createTimer();
        store.cancelJob(userId, first);

        const pending = await request(buildApp())
            .get("/api/jobs")
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(pending.body.jobs).toHaveLength(1);

        const all = await request(buildApp())
            .get("/api/jobs?includeSettled=true")
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(all.body.jobs).toHaveLength(2);
        expect(all.body.jobs.map((j: { state: string }) => j.state)).toEqual([
            "pending",
            "cancelled",
        ]);

        const page = await request(buildApp())
            .get("/api/jobs?limit=1")
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(page.body.jobs).toHaveLength(1);
    });

    it("shows what a run did, newest first", async () => {
        const id = await createTimer();
        store.startJobRun({
            id: "run-1",
            jobId: id,
            startedAt: iso(10),
        });
        store.finishJobRun(
            "run-1",
            "ok",
            { output: "The kettle boiled." },
            iso(11),
        );

        const detail = await request(buildApp())
            .get(`/api/jobs/${id}`)
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(detail.body.runs).toEqual([
            {
                id: "run-1",
                state: "ok",
                startedAt: iso(10),
                finishedAt: iso(11),
                output: "The kettle boiled.",
            },
        ]);
    });

    it("scopes every route to the caller, and bounds the id it will look up", async () => {
        const id = await createTimer();
        const pepper = store.createUser("pepper", "hash", "user");
        const material = generateDeviceToken();
        store.createDevice(
            pepper.id,
            "pepper-web",
            material.tokenHash,
            material.prefix,
        );

        // Somebody else's job is indistinguishable from one that does not
        // exist — there is no 403 that would confirm the id is real.
        for (const call of [
            request(buildApp()).get(`/api/jobs/${id}`),
            request(buildApp()).patch(`/api/jobs/${id}`).send({ label: "x" }),
            request(buildApp()).delete(`/api/jobs/${id}`),
            request(buildApp()).post(`/api/jobs/${id}/snooze`).send({
                minutes: 10,
            }),
        ]) {
            await call
                .set("authorization", `Bearer ${material.token}`)
                .expect(404);
        }
        // An id that cannot exist is refused before the lookup.
        await request(buildApp())
            .get(`/api/jobs/${"x".repeat(65)}`)
            .set("authorization", `Bearer ${token}`)
            .expect(400);
        // And nothing about the job changed for its owner.
        expect(store.getJob(userId, id)).toMatchObject({ label: "Kettle" });
    });

    it("edits a pending job's label and moment", async () => {
        const id = await createTimer();

        const edited = await request(buildApp())
            .patch(`/api/jobs/${id}`)
            .set("authorization", `Bearer ${token}`)
            .send({ label: "Tea", runAt: iso(45) })
            .expect(200);

        expect(edited.body.job).toMatchObject({
            label: "Tea",
            runAt: iso(45),
            state: "pending",
        });
        expect(edited.body.quiet).toEqual({ state: "clear" });

        // An edit that changes nothing is a mistake, not a silent no-op.
        await request(buildApp())
            .patch(`/api/jobs/${id}`)
            .set("authorization", `Bearer ${token}`)
            .send({})
            .expect(400);
        // Class and kind are what the job *is*, and a class change is how
        // loudly the user is interrupted — so it is refused rather than applied.
        await request(buildApp())
            .patch(`/api/jobs/${id}`)
            .set("authorization", `Bearer ${token}`)
            .send({ class: "reminder" })
            .expect(400);
        // A message for a job that has none would violate the table's kind
        // CHECK, so it is refused before it gets there.
        store.createJob(userId, {
            id: "tool-1",
            label: "Porch lights",
            kind: "tool",
            toolName: "homeAssistant",
            toolArgs: { action: "turn_on" },
            runAt: iso(30),
            createdAt: NOW.toISOString(),
        });
        await request(buildApp())
            .patch("/api/jobs/tool-1")
            .set("authorization", `Bearer ${token}`)
            .send({ message: "hello" })
            .expect(400);
        expect(store.getJob(userId, id)?.label).toBe("Tea");
    });

    it("refuses to edit a job that is already running", async () => {
        const id = await createTimer();
        store.claimJob(id);

        const refused = await request(buildApp())
            .patch(`/api/jobs/${id}`)
            .set("authorization", `Bearer ${token}`)
            .send({ label: "Too late" })
            .expect(409);

        expect(refused.body.error).toContain("running");
        expect(store.getJob(userId, id)?.label).toBe("Kettle");
    });

    it("cancels a pending job once, and not twice", async () => {
        const id = await createTimer();

        const cancelled = await request(buildApp())
            .delete(`/api/jobs/${id}`)
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(cancelled.body.job).toMatchObject({
            state: "cancelled",
            label: "Kettle",
        });
        expect(store.getJob(userId, id)?.settledAt).not.toBeNull();

        // Idempotence is refused rather than faked: the state came from the
        // read, so a second call says so instead of reporting a fresh cancel.
        await request(buildApp())
            .delete(`/api/jobs/${id}`)
            .set("authorization", `Bearer ${token}`)
            .expect(409);
    });

    it("snoozes a pending reminder by moving it", async () => {
        const created = await request(buildApp())
            .post("/api/jobs")
            .set("authorization", `Bearer ${token}`)
            .send({ label: "Call Mum", class: "reminder", runAt: iso(60) })
            .expect(201);
        const id = created.body.job.id as string;

        const snoozed = await request(buildApp())
            .post(`/api/jobs/${id}/snooze`)
            .set("authorization", `Bearer ${token}`)
            .send({ minutes: 15 })
            .expect(200);

        expect(snoozed.body.action).toBe("moved");
        expect(snoozed.body.job).toMatchObject({
            id,
            runAt: iso(15),
            state: "pending",
            // A move is not an attempt: nothing was tried, so nothing is counted.
            attempts: 0,
        });
        expect(snoozed.body.previousRunAt).toBeUndefined();
        expect(snoozed.body.quiet).toEqual({ state: "clear" });
        expect(store.listJobs(userId)).toHaveLength(1);
    });

    it("snoozes a settled reminder by setting it again", async () => {
        const created = await request(buildApp())
            .post("/api/jobs")
            .set("authorization", `Bearer ${token}`)
            .send({ label: "Call Mum", class: "reminder", runAt: iso(60) })
            .expect(201);
        const id = created.body.job.id as string;
        store.claimJob(id);
        store.settleJob(id, "done", {}, iso(61));

        const snoozed = await request(buildApp())
            .post(`/api/jobs/${id}/snooze`)
            .set("authorization", `Bearer ${token}`)
            .send({ minutes: 30 })
            .expect(200);

        expect(snoozed.body.action).toBe("recreated");
        expect(snoozed.body.job.id).not.toBe(id);
        expect(snoozed.body.job).toMatchObject({
            label: "Call Mum",
            class: "reminder",
            message: "Call Mum",
            runAt: iso(30),
        });
        // The moment the settled one was owed, so the caller can say what it is
        // replacing.
        expect(snoozed.body.previousRunAt).toBe(iso(60));
    });

    it("refuses to snooze anything that is not a reminder", async () => {
        const id = await createTimer();

        const refused = await request(buildApp())
            .post(`/api/jobs/${id}/snooze`)
            .set("authorization", `Bearer ${token}`)
            .send({ minutes: 10 })
            .expect(400);
        expect(refused.body.error).toContain("not a reminder");
        expect(store.getJob(userId, id)?.runAt).toBe(iso(10));
    });

    it("carries the job link on an announcement, and omits it elsewhere", async () => {
        const id = await createTimer();
        store.createNotification(userId, {
            id: "n1",
            kind: "job.finished",
            class: "timer",
            priority: "normal",
            title: "Kettle",
            jobId: id,
            createdAt: iso(11),
        });
        store.createNotification(userId, {
            id: "n2",
            kind: "agent.request",
            priority: "normal",
            title: "standalone",
            createdAt: iso(12),
        });

        const listed = await request(buildApp())
            .get("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        const byId = Object.fromEntries(
            (listed.body.notifications as { id: string; jobId?: string }[]).map(
                (n) => [n.id, n],
            ),
        );
        // The link is what lets a banner act on the reminder rather than only
        // acknowledge it — and a notification no job stands behind carries no
        // key at all rather than a null.
        expect(byId.n1.jobId).toBe(id);
        expect("jobId" in byId.n2).toBe(false);
    });

    /** A daily rule anchored at the fixed clock: 19:05 every day. */
    const daily = { every: "day", interval: 1, start: NOW.toISOString() };

    it("creates a repeating job and answers with its rule", async () => {
        const created = await request(buildApp())
            .post("/api/jobs")
            .set("authorization", `Bearer ${token}`)
            .send({
                label: "Standup",
                class: "reminder",
                runAt: iso(10),
                repeat: daily,
            })
            .expect(201);

        expect(created.body.job.repeat).toEqual(daily);
        // The rule decided the moment, not the picker: tomorrow, same clock.
        expect(created.body.job.runAt).toBe(
            new Date(2026, 0, 2, 19, 5).toISOString(),
        );
    });

    it("refuses a schedule this server will not keep, saying why", async () => {
        const refused = await request(buildApp())
            .post("/api/jobs")
            .set("authorization", `Bearer ${token}`)
            .send({
                label: "Kettle",
                class: "timer",
                runAt: iso(10),
                repeat: daily,
            })
            .expect(400);

        expect(refused.body.error).toMatch(/a timer is a countdown/);
    });

    it("stops a series through the edit", async () => {
        const id = await createTimer({ class: "reminder", repeat: daily });

        const stopped = await request(buildApp())
            .patch(`/api/jobs/${id}`)
            .set("authorization", `Bearer ${token}`)
            .send({ repeat: null })
            .expect(200);

        // Cleared, so the wire says nothing about it at all.
        expect(stopped.body.job.repeat).toBeUndefined();
        expect(store.getJob(userId, id)?.repeat).toBeNull();
    });

    it("cancels a repeating job while it runs, and a one-shot never", async () => {
        const series = await createTimer({ class: "reminder", repeat: daily });
        const oneShot = await createTimer();
        // Mid-run is what a claim leaves behind.
        store.claimJob(series);
        store.claimJob(oneShot);

        const stopped = await request(buildApp())
            .delete(`/api/jobs/${series}`)
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(stopped.body.job.state).toBe("cancelled");

        // A one-shot's result is the whole job, and it is on its way.
        await request(buildApp())
            .delete(`/api/jobs/${oneShot}`)
            .set("authorization", `Bearer ${token}`)
            .expect(409);
    });
});
