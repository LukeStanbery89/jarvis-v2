/**
 * Ambient types for `openwakeword-web/microphone`.
 *
 * The package exposes this module only through its exports map, which this
 * package's `moduleResolution: node` config cannot see (node10 resolution
 * does not honor `exports`). This shim mirrors the slice of the library's
 * `src/microphone.d.ts` that the openWakeWord provider drives; Vite/Rollup
 * resolve the real module at build time on its genuine subpath export. It
 * also fixes the int16-onFrame convention the provider relies on.
 */
declare module "openwakeword-web/microphone" {
    /** 16 kHz 16-bit PCM capture helper backed by an AudioWorklet. */
    export class Microphone {
        constructor(
            onFrame: (frame: Int16Array) => void,
            opts?: { workletUrl?: string },
        );
        readonly sampleRate: number | null;
        start(): Promise<void>;
        stop(): Promise<void>;
    }
}
