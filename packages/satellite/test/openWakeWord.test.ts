import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import {
    OpenWakeWordDetector,
    WAKE_FRAME_SAMPLES,
    type WakeEngine,
} from "../src/openWakeWord";

/** A fake ONNX engine: frame[0] is a wake marker, otherwise silence/audio. */
function fakeEngine(): WakeEngine {
    return {
        async predict(frame: Int16Array): Promise<Record<string, number>> {
            return { hey_jarvis: frame[0] === 1 ? 0.95 : 0 };
        },
        async reset(): Promise<void> {
            // No streaming state in the fake.
        },
    };
}

describe("OpenWakeWordDetector", () => {
    it("fires once and emits command audio after the phrase", async () => {
        const config = loadConfig({
            ...process.env,
            JARVIS_SATELLITE_STATE_DIR: "/tmp/jarvis-oww-test-state",
        });
        const detector = new OpenWakeWordDetector(config, async () =>
            fakeEngine(),
        );
        let wake = 0;
        let command: Float32Array | null = null;
        await detector.start({
            onWake: () => {
                wake += 1;
            },
            onCommand: (pcm) => {
                command = pcm;
            },
            onError: (error) => {
                throw error;
            },
        });

        const silence = (): Int16Array => new Int16Array(WAKE_FRAME_SAMPLES);
        const wakeFrame = (): Int16Array => {
            const frame = new Int16Array(WAKE_FRAME_SAMPLES);
            frame[0] = 1;
            return frame;
        };
        const speechFrame = (): Int16Array =>
            new Int16Array(WAKE_FRAME_SAMPLES).fill(1_000);

        for (let i = 0; i < 20; i += 1) detector.push(silence());
        for (let i = 0; i < 20; i += 1) detector.push(wakeFrame());
        for (let i = 0; i < 20; i += 1) detector.push(speechFrame());
        for (let i = 0; i < 60; i += 1) detector.push(silence());

        await new Promise((resolve) => setTimeout(resolve, 500));
        detector.stop();

        expect(wake).toBe(1);
        expect(command).not.toBeNull();
        expect(command!.length).toBeGreaterThan(0);
    });

    it("does not fire for silence", async () => {
        const config = loadConfig({
            ...process.env,
            JARVIS_SATELLITE_STATE_DIR: "/tmp/jarvis-oww-test-state",
        });
        const detector = new OpenWakeWordDetector(config, async () =>
            fakeEngine(),
        );
        let wake = 0;
        await detector.start({
            onWake: () => {
                wake += 1;
            },
            onCommand: () => undefined,
            onError: (error) => {
                throw error;
            },
        });
        for (let i = 0; i < 100; i += 1) {
            detector.push(new Int16Array(WAKE_FRAME_SAMPLES));
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        detector.stop();
        expect(wake).toBe(0);
    });
});
