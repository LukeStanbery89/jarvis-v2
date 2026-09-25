/**
 * Prefs view: per-user integration preferences (`/api/prefs`).
 *
 * Non-owners edit their own prefs; owners can switch into any account's prefs
 * via the selector (as `/api/users/:id/prefs`). The editor works on raw
 * key → JSON-string pairs; values are parsed with `JSON.parse` before an upsert
 * (the server re-validates). "Clear all" uses the DELETE routes so a user can
 * really empty their prefs.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ApiUser, Prefs } from "../types";
import {
    Button,
    ErrorBanner,
    Form,
    SubmitButton,
    confirm,
    errorMessage,
} from "../components/ui";

interface Entry {
    key: string;
    value: string;
}

function prefsToEntries(prefs: Prefs): Entry[] {
    return Object.entries(prefs).map(([key, value]) => ({
        key,
        value: JSON.stringify(value),
    }));
}

/** Parses a pref entry's value text, or returns an error message. */
function validateEntry(entry: Entry): string | null {
    if (entry.key.trim().length === 0) {
        return "pref keys cannot be empty";
    }
    try {
        JSON.parse(entry.value);
        return null;
    } catch {
        return `"${entry.key}" is not valid JSON`;
    }
}

export function PrefsView({ me }: { me: ApiUser }) {
    const owner = me.role === "owner";
    const [users, setUsers] = useState<ApiUser[]>([]);
    const [userId, setUserId] = useState<number | undefined>(undefined);
    const [entries, setEntries] = useState<Entry[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const userOptions = useCallback(
        () => [...users].sort((a, b) => a.username.localeCompare(b.username)),
        [users],
    );

    const reloadUsers = useCallback(async () => {
        if (!owner) {
            return;
        }
        try {
            setUsers(await api.listUsers());
        } catch (err) {
            setError(errorMessage(err));
        }
    }, [owner]);

    const reloadPrefs = useCallback(async (target: number | undefined) => {
        setError(null);
        try {
            setEntries(prefsToEntries(await api.getPrefs(target)));
        } catch (err) {
            setError(errorMessage(err));
            setEntries([]);
        }
    }, []);

    useEffect(() => {
        void reloadUsers();
    }, [reloadUsers]);

    useEffect(() => {
        setEntries([]);
        void reloadPrefs(userId);
    }, [reloadPrefs, userId]);

    const save = async () => {
        const invalid = entries.map(validateEntry).find((msg) => msg !== null);
        if (invalid) {
            setError(invalid);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const prefs: Prefs = {};
            for (const entry of entries) {
                if (entry.key.trim().length > 0) {
                    prefs[entry.key] = JSON.parse(entry.value) as unknown;
                }
            }
            setEntries(prefsToEntries(await api.setPrefs(userId, prefs)));
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const clearAll = async () => {
        if (!confirm("Delete every preference for this user?")) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await api.clearPrefs(userId);
            setEntries([]);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const patchEntry = (index: number, patch: Partial<Entry>) => {
        setEntries((prev) =>
            prev.map((entry, i) =>
                i === index ? { ...entry, ...patch } : entry,
            ),
        );
    };

    return (
        <div className="page">
            <h1>Preferences</h1>
            <ErrorBanner>{error}</ErrorBanner>

            {owner ? (
                <section className="panel">
                    <h2>Scope</h2>
                    <label className="field">
                        <span>Editing prefs for</span>
                        <select
                            value={userId ?? me.id}
                            onChange={(e) =>
                                setUserId(
                                    Number(e.target.value) === me.id
                                        ? undefined
                                        : Number(e.target.value),
                                )
                            }
                        >
                            <option value={me.id}>my own prefs</option>
                            {userOptions()
                                .filter((user) => user.id !== me.id)
                                .map((user) => (
                                    <option key={user.id} value={user.id}>
                                        {user.username}
                                    </option>
                                ))}
                        </select>
                    </label>
                </section>
            ) : null}

            <section className="panel">
                <h2>Integration prefs</h2>
                <p className="muted">
                    One key per row; values are JSON (strings, numbers,
                    booleans, objects, arrays).
                </p>
                {entries.map((entry, index) => (
                    <div className="pref-row" key={index}>
                        <input
                            className="inline"
                            placeholder="key"
                            value={entry.key}
                            onChange={(e) =>
                                patchEntry(index, { key: e.target.value })
                            }
                        />
                        <input
                            className="inline grow"
                            placeholder='value (JSON literals), e.g. "grid" or 7.5'
                            value={entry.value}
                            onChange={(e) =>
                                patchEntry(index, { value: e.target.value })
                            }
                        />
                        <Button
                            variant="ghost"
                            onClick={() =>
                                setEntries((prev) =>
                                    prev.filter((_, i) => i !== index),
                                )
                            }
                        >
                            Remove
                        </Button>
                    </div>
                ))}
                <div className="pref-row">
                    <Button
                        variant="ghost"
                        onClick={() =>
                            setEntries((prev) => [
                                ...prev,
                                { key: "", value: "null" },
                            ])
                        }
                    >
                        Add key
                    </Button>
                </div>
                <div className="actions">
                    <Form onSubmit={() => void save()}>
                        <SubmitButton disabled={busy}>
                            {busy ? "Saving…" : "Save"}
                        </SubmitButton>
                    </Form>
                    <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => void clearAll()}
                    >
                        Clear all
                    </Button>
                </div>
            </section>
        </div>
    );
}
