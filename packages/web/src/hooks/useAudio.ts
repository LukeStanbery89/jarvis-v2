/**
 * Spoken-response player hook for the chat view (#83).
 *
 * Owns one {@link AudioPlayer} for the view's lifetime (a render-ref, since the
 * player tolerates recreation but must not churn per render), exposes its
 * `speaking` external-store snapshot to React, and disposes it on unmount. The
 * context factory is injectable so the hook can be exercised without WebAudio.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { AudioPlayer } from "../audio";

/** The public surface {@link useAudio} returns. */
export interface UseAudioResult {
    /** The stable player instance (feed it PCM chunks; unlock before playback). */
    audio: AudioPlayer;
    /** Whether scheduled audio remains (drives the speaking indicator). */
    speaking: boolean;
    /** Stops all scheduled playback (stop button, barge-in). */
    stop(): void;
    /** Resumes the audio context (call from the mic-press user gesture). */
    unlock(): void;
}

/**
 * Creates and owns the chat view's audio player.
 *
 * @param options.createContext - AudioContext factory override (tests).
 * @returns The player, its speaking snapshot, and the stop/unlock helpers.
 */
export function useAudio(options?: {
    createContext?: () => AudioContext | null;
}): UseAudioResult {
    const audioRef = useRef<AudioPlayer | null>(null);
    if (audioRef.current === null) {
        audioRef.current = new AudioPlayer(
            options?.createContext
                ? { createContext: options.createContext }
                : {},
        );
    }
    const audio = audioRef.current;

    const subscribe = useCallback(
        (onStoreChange: () => void) => audio.subscribe(onStoreChange),
        [audio],
    );
    const getSnapshot = useCallback(() => audio.getSnapshot(), [audio]);
    const speaking = useSyncExternalStore(subscribe, getSnapshot);

    // The player holds a hardware context — close it with the view.
    useEffect(() => () => audio.dispose(), [audio]);

    const stop = useCallback((): void => audio.stop(), [audio]);
    const unlock = useCallback((): void => audio.unlock(), [audio]);

    return { audio, speaking, stop, unlock };
}
