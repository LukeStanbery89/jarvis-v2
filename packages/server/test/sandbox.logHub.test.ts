/**
 * The coding log hub (#141 phase 7).
 *
 * What matters here is the boundary between "following" and "finished": a late
 * joiner gets the replay and an immediate end, a live listener gets every line
 * and exactly one end, and the ring never grows past its window.
 */
import { describe, expect, it, vi } from "vitest";
import { createCodingLogHub } from "../src/sandbox/logHub";

describe("coding log hub", () => {
    it("replays the ring and then follows live lines", () => {
        const hub = createCodingLogHub();
        hub.publish("job-1", "one");
        hub.publish("job-1", "two");

        const stream = hub.open("job-1");
        expect(stream.replay).toEqual(["one", "two"]);

        const onLine = vi.fn();
        const onEnd = vi.fn();
        const unsubscribe = stream.subscribe({ onLine, onEnd });
        hub.publish("job-1", "three");
        expect(onLine).toHaveBeenCalledWith("three");
        expect(onEnd).not.toHaveBeenCalled();

        unsubscribe();
        hub.publish("job-1", "four");
        expect(onLine).toHaveBeenCalledTimes(1);
    });

    it("ends every listener once when the job finishes", () => {
        const hub = createCodingLogHub();
        const first = { onLine: vi.fn(), onEnd: vi.fn() };
        const second = { onLine: vi.fn(), onEnd: vi.fn() };
        const stream = hub.open("job-1");
        stream.subscribe(first);
        stream.subscribe(second);

        hub.finish("job-1");
        hub.finish("job-1");

        expect(first.onEnd).toHaveBeenCalledTimes(1);
        expect(second.onEnd).toHaveBeenCalledTimes(1);
        hub.publish("job-1", "after the end");
        expect(first.onLine).not.toHaveBeenCalled();
    });

    it("gives a late joiner the replay and an immediate end", async () => {
        const hub = createCodingLogHub();
        hub.publish("job-1", "one");
        hub.finish("job-1");

        const stream = hub.open("job-1");
        expect(stream.replay).toEqual(["one"]);
        const onEnd = vi.fn();
        stream.subscribe({ onLine: vi.fn(), onEnd });
        await Promise.resolve();
        expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("keeps only the newest ring lines", () => {
        const hub = createCodingLogHub({ ringLines: 3 });
        for (const line of ["1", "2", "3", "4", "5"]) {
            hub.publish("job-1", line);
        }
        expect(hub.open("job-1").replay).toEqual(["3", "4", "5"]);
    });

    it("drops the oldest finished job past its cap", () => {
        const hub = createCodingLogHub({ maxJobs: 2 });
        hub.publish("job-1", "one");
        hub.finish("job-1");
        hub.publish("job-2", "two");
        hub.publish("job-3", "three");

        expect(hub.open("job-1").replay).toEqual([]);
        expect(hub.open("job-2").replay).toEqual(["two"]);
        expect(hub.open("job-3").replay).toEqual(["three"]);
    });
});
