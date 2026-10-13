/**
 * REST session-list hook for the chat sidebar.
 *
 * Owns the caller's own session rows (`GET /api/sessions`, filtered to the
 * signed-in `userId` — owner listings include other accounts) plus the one
 * mount refresh. Token/userId/onAuthRejected are read through latest-value
 * refs, so the mount effect runs exactly once regardless of prop churn; a 401
 * reports a dead credential via `onAuthRejected`, while other failures stay
 * non-fatal (the sidebar keeps local threads). Callers re-fetch after a turn or
 * a delete through the returned `refreshSessions`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type SessionSummary } from "../api";

/** The public surface {@link useSessions} returns. */
export interface UseSessionsResult {
    /** The caller's own session rows. */
    rows: SessionSummary[];
    /** Re-fetches the caller's rows (turn-end, after a delete). */
    refreshSessions(): Promise<void>;
}

/**
 * Fetches and owns the caller's session rows.
 *
 * @param options.token - The bearer device token.
 * @param options.userId - The signed-in account id (row filter).
 * @param options.onAuthRejected - Called on a 401 (dead credential).
 * @returns The current rows and the refresh function.
 */
export function useSessions(options: {
    token: string;
    userId: number;
    onAuthRejected(): void;
}): UseSessionsResult {
    const { token, userId, onAuthRejected } = options;
    /** Latest props (the mount effect must not re-run on prop churn). */
    const tokenRef = useRef(token);
    tokenRef.current = token;
    const userIdRef = useRef(userId);
    userIdRef.current = userId;
    const onAuthRejectedRef = useRef(onAuthRejected);
    onAuthRejectedRef.current = onAuthRejected;

    const [rows, setRows] = useState<SessionSummary[]>([]);

    const refreshSessions = useCallback(async (): Promise<void> => {
        try {
            const all = await api.listSessions(tokenRef.current);
            setRows(all.filter((row) => row.userId === userIdRef.current));
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
                onAuthRejectedRef.current();
            }
            // Other failures are non-fatal: the sidebar keeps local threads.
        }
    }, []);

    // One mount refresh; turn-end refreshes come from `refreshSessions`.
    useEffect(() => {
        void refreshSessions();
    }, [refreshSessions]);

    return { rows, refreshSessions };
}
