/**
 * Type declarations for the build-time asset copier (see
 * `copy-voice-assets.mjs`). Kept separate so the ESM script itself stays
 * plain JavaScript while `vite.config.ts` (type-checked) can import it.
 */

/**
 * Stages the wake-word runtime assets into `public/ort/`.
 *
 * @returns The destination paths written.
 */
export declare function copyVoiceAssets(): string[];
