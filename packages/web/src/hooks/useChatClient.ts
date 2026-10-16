/**
 * WebSocket chat-client hook (StrictMode-safe).
 *
 * The client is constructed **inside a mount effect**, not during render, so
 * React's StrictMode double-invoke (mount → simulated unmount → mount) leaves a
 * fresh, connected instance in charge instead of a permanently-closed one. Each
 * instance runs the hello+auth handshake, reconnects with backoff on drops, and
 * reports a permanent auth failure through `onAuthRejected`.
 *
 * Event callbacks install through latest-value refs, so the fixed instance
 * always sees the current render's handlers. `url` and `socketFactory` stay
 * injectable (defaulting to `webSocketUrl()` and the browser `WebSocket`) to
 * preserve the wire tests' socket seam.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
    ClientCapability,
    NotificationFrame,
    ServerFrame,
} from "@lukestanbery/jarvis-protocol";
import {
    ChatClient,
    type ChatStatus,
    type WebSocketFactory,
} from "../ChatClient";
import { webSocketUrl } from "../wsUrl";

/** The public surface {@link useChatClient} returns. */
export interface UseChatClientResult {
    /** The client, or `null` before the first mount effect runs. */
    client: ChatClient | null;
    /** Connection lifecycle for the status line. */
    status: ChatStatus;
    /** Whether a prompt turn is currently streaming. */
    isStreaming(): boolean;
    /** Cancels the in-flight turn (stop button, barge-in). */
    cancelTurn(): void;
    /** Sends a `location` frame (announced on every handshake). */
    sendLocation(lat: number, lon: number): void;
}

/**
 * Owns one {@link ChatClient} for the view's lifetime.
 *
 * @param options.token - The device token the client authenticates with.
 * @param options.capabilities - The `hello` capabilities (a module-level const
 *   in the caller, so the construction effect never re-runs).
 * @param options.onAudio - One binary PCM chunk of the in-flight turn.
 * @param options.onFrame - One parsed server frame of the in-flight turn.
 * @param options.onNotification - One out-of-turn notification frame (#139).
 * @param options.onReconnected - The socket recovered from a drop (#139).
 * @param options.onAuthRejected - The credential is permanently unusable.
 * @param options.url - Socket URL override (default {@link webSocketUrl}).
 * @param options.socketFactory - Socket constructor override (tests).
 * @returns The client (null pre-mount), status, and the wire helpers.
 */
export function useChatClient(options: {
    token: string;
    capabilities: ClientCapability[];
    onAudio(pcm: Float32Array): void;
    onFrame(frame: ServerFrame): void;
    /** One server-initiated notification frame, outside any turn (#139). */
    onNotification(notification: NotificationFrame["notification"]): void;
    /**
     * The socket recovered from a drop (#139): re-read anything the server
     * could not push while it was down.
     */
    onReconnected(): void;
    onAuthRejected(): void;
    url?: string;
    socketFactory?: WebSocketFactory;
}): UseChatClientResult {
    const { url, socketFactory } = options;
    const [client, setClient] = useState<ChatClient | null>(null);
    const [status, setStatus] = useState<ChatStatus>("connecting");

    /** Latest props: the fixed instance reads the current render's handlers. */
    const tokenRef = useRef(options.token);
    tokenRef.current = options.token;
    const capabilitiesRef = useRef(options.capabilities);
    capabilitiesRef.current = options.capabilities;
    const onAudioRef = useRef(options.onAudio);
    onAudioRef.current = options.onAudio;
    const onFrameRef = useRef(options.onFrame);
    onFrameRef.current = options.onFrame;
    const onNotificationRef = useRef(options.onNotification);
    onNotificationRef.current = options.onNotification;
    const onReconnectedRef = useRef(options.onReconnected);
    onReconnectedRef.current = options.onReconnected;
    const onAuthRejectedRef = useRef(options.onAuthRejected);
    onAuthRejectedRef.current = options.onAuthRejected;

    // Construct in the effect (StrictMode fix): connect → close → fresh connect
    // on separate instances rather than leaving a user-closed client in charge.
    useEffect(() => {
        const instance = new ChatClient(url ?? webSocketUrl(), {
            token: tokenRef.current,
            capabilities: capabilitiesRef.current,
            ...(socketFactory === undefined ? {} : { socketFactory }),
            events: {
                onStatus: (next) => setStatus(next),
                onAudio: (pcm) => onAudioRef.current(pcm),
                onFrame: (frame) => onFrameRef.current(frame),
                onNotification: (notification) =>
                    onNotificationRef.current(notification),
                onReconnected: () => onReconnectedRef.current(),
                onAuthRejected: () => onAuthRejectedRef.current(),
            },
        });
        setClient(instance);
        instance.connect();
        return () => {
            setClient(null);
            instance.close();
        };
        // `url`/`socketFactory` are construction-time seams; callers pass stable
        // values (defaults or test doubles), so this runs once per mount.
    }, [url, socketFactory]);

    const isStreaming = useCallback(
        (): boolean => client?.isStreaming() ?? false,
        [client],
    );
    const cancelTurn = useCallback((): void => {
        client?.cancelTurn();
    }, [client]);
    const sendLocation = useCallback(
        (lat: number, lon: number): void => {
            client?.sendLocation(lat, lon);
        },
        [client],
    );

    return { client, status, isStreaming, cancelTurn, sendLocation };
}
