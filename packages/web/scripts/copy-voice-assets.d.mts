/**
 * Type declarations for the build-time asset copier (see
 * `copy-voice-assets.mjs`). Kept separate so the ESM script itself stays
 * plain JavaScript while `vite.config.ts` (type-checked) can import it.
 */

/**
 * Locates an installed package's directory by walking `node_modules` upward
 * from `fromDir`.
 *
 * @param name - Package name to find.
 * @param fromDir - Directory to start the upward walk at.
 * @returns The package's root directory.
 * @throws When no `node_modules/<name>` exists between `fromDir` and the
 *   filesystem root.
 */
export declare function findPackageRoot(name: string, fromDir: string): string;

/**
 * Stages the wake-word runtime assets into `public/ort/`.
 *
 * @returns The destination paths written.
 */
export declare function copyVoiceAssets(): string[];
