/**
 * Users view (owner-only): manage accounts.
 *
 * Lists every account and offers the full lifecycle the REST API exposes —
 * create, role promote/demote, and disable/enable. The owner's own row cannot
 * be disabled (the server rejects it with 400, surfaced inline) and demoting
 * the last **enabled** owner is refused by the API (`LAST_OWNER` → 409), so
 * the zero-owner lockout stays unreachable from the browser without a fresh
 * store.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ApiUser } from "../types";
import {
    Button,
    ErrorBanner,
    Field,
    Form,
    SubmitButton,
    confirm,
    errorMessage,
} from "../components/ui";

export function UsersView({ me }: { me: ApiUser }) {
    const [users, setUsers] = useState<ApiUser[] | null>(null);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [role, setRole] = useState<"owner" | "user">("user");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const reload = useCallback(async () => {
        try {
            setUsers(await api.listUsers());
        } catch (err) {
            setError(errorMessage(err));
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    const create = async () => {
        setBusy(true);
        setError(null);
        try {
            await api.createUser(username, password, role);
            setUsername("");
            setPassword("");
            setRole("user");
            await reload();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const setRoleFor = async (user: ApiUser, nextRole: "owner" | "user") => {
        setError(null);
        try {
            await api.updateUser(user.id, { role: nextRole });
            await reload();
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    const toggleDisabled = async (user: ApiUser) => {
        const verb = user.disabled ? "reenable" : "disable";
        if (!confirm(`${verb} ${user.username}?`)) {
            return;
        }
        setError(null);
        try {
            await api.updateUser(user.id, { disabled: !user.disabled });
            await reload();
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    if (users === null) {
        return <p className="muted">Loading users…</p>;
    }

    return (
        <div className="page">
            <h1>Users</h1>
            <ErrorBanner>{error}</ErrorBanner>

            <section className="panel">
                <h2>Create account</h2>
                <Form onSubmit={() => void create()}>
                    <Field
                        label="Username"
                        value={username}
                        onChange={setUsername}
                        required
                    />
                    <Field
                        label="Password"
                        type="password"
                        value={password}
                        onChange={setPassword}
                        required
                        minLength={8}
                    />
                    <label className="field">
                        <span>Role</span>
                        <select
                            value={role}
                            onChange={(e) =>
                                setRole(e.target.value as "owner" | "user")
                            }
                        >
                            <option value="user">user</option>
                            <option value="owner">owner</option>
                        </select>
                    </label>
                    <SubmitButton disabled={busy}>
                        {busy ? "Creating…" : "Create"}
                    </SubmitButton>
                </Form>
            </section>

            <section className="panel">
                <h2>Accounts</h2>
                <table className="grid">
                    <thead>
                        <tr>
                            <th>Username</th>
                            <th>Role</th>
                            <th>Status</th>
                            <th>Created</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((user) => (
                            <tr key={user.id}>
                                <td>
                                    {user.username}
                                    {user.id === me.id ? (
                                        <span className="badge">you</span>
                                    ) : null}
                                </td>
                                <td>{user.role}</td>
                                <td>
                                    <span
                                        className={
                                            user.disabled
                                                ? "badge danger"
                                                : "badge ok"
                                        }
                                    >
                                        {user.disabled ? "disabled" : "active"}
                                    </span>
                                </td>
                                <td>
                                    {new Date(user.createdAt).toLocaleString()}
                                </td>
                                <td className="actions">
                                    {user.role === "user" ? (
                                        <Button
                                            variant="ghost"
                                            onClick={() =>
                                                void setRoleFor(user, "owner")
                                            }
                                        >
                                            Make owner
                                        </Button>
                                    ) : (
                                        <Button
                                            variant="ghost"
                                            onClick={() =>
                                                void setRoleFor(user, "user")
                                            }
                                        >
                                            Demote
                                        </Button>
                                    )}
                                    <Button
                                        variant={
                                            user.disabled ? "primary" : "danger"
                                        }
                                        disabled={user.id === me.id}
                                        onClick={() =>
                                            void toggleDisabled(user)
                                        }
                                    >
                                        {user.disabled
                                            ? "Re-enable"
                                            : "Disable"}
                                    </Button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        </div>
    );
}
