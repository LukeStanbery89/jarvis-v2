/**
 * Sessions view: the chat-thread ledger (`/api/sessions`).
 *
 * Every user sees and may delete their own sessions; the owner sees every
 * session with its owning `userId` resolved to a username. Deleting a session
 * only removes the ledger row — the thread stays in the LangGraph checkpointer,
 * matching the REST `DELETE /api/sessions/:threadId` semantics.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ApiSession, ApiUser } from "../types";
import { Button, ErrorBanner, confirm, errorMessage } from "../components/ui";

export function SessionsView({ me }: { me: ApiUser }) {
    const owner = me.role === "owner";
    const [sessions, setSessions] = useState<ApiSession[] | null>(null);
    const [users, setUsers] = useState<Map<number, string>>(new Map());
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        setError(null);
        try {
            const [list, userRows] = await Promise.all([
                api.listSessions(),
                owner ? api.listUsers() : Promise.resolve([] as ApiUser[]),
            ]);
            setSessions(list);
            setUsers(
                new Map(
                    userRows.map((user) => [user.id, user.username] as const),
                ),
            );
        } catch (err) {
            setError(errorMessage(err));
        }
    }, [owner]);

    useEffect(() => {
        void reload();
    }, [reload]);

    const remove = async (session: ApiSession) => {
        if (!confirm(`Delete session ${session.threadId}?`)) {
            return;
        }
        setError(null);
        try {
            await api.deleteSession(session.threadId);
            await reload();
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    const rows = useMemo(
        () =>
            (sessions ?? []).sort((a, b) =>
                b.lastActiveAt.localeCompare(a.lastActiveAt),
            ),
        [sessions],
    );

    if (sessions === null) {
        return <p className="muted">Loading sessions…</p>;
    }

    return (
        <div className="page">
            <h1>Sessions</h1>
            <p className="muted">
                {owner
                    ? "Every active chat session across the server."
                    : "Your active chat sessions."}
            </p>
            <ErrorBanner>{error}</ErrorBanner>
            {sessions.length === 0 ? (
                <p className="muted">No sessions yet.</p>
            ) : (
                <table className="grid">
                    <thead>
                        <tr>
                            <th>Thread</th>
                            <th>Kind</th>
                            <th>User</th>
                            <th>Last active</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((session) => (
                            <tr key={session.threadId}>
                                <td className="mono">{session.threadId}</td>
                                <td>{session.kind}</td>
                                <td>
                                    {session.userId === null
                                        ? "guest"
                                        : (users.get(session.userId) ??
                                          `#${session.userId}`)}
                                </td>
                                <td>
                                    {new Date(
                                        session.lastActiveAt,
                                    ).toLocaleString()}
                                </td>
                                <td className="actions">
                                    <Button
                                        variant="danger"
                                        onClick={() => void remove(session)}
                                    >
                                        Delete
                                    </Button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
