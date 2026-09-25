/**
 * Devices view: manage device credentials.
 *
 * Owners pick any account (via the user selector) and see/manage that user's
 * devices through `GET /api/users/:id/devices`; non-owners manage their own
 * devices from `/api/me`. Includes provisioning (the freshly issued token is
 * shown once — it is never stored server-side after issuance) and the shared
 * device filemap (id, name, prefix, created/last-seen), rename, and revoke.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ApiDevice, ApiUser } from "../types";
import {
    Button,
    Copyable,
    ErrorBanner,
    Field,
    Form,
    InfoBanner,
    SubmitButton,
    confirm,
    errorMessage,
} from "../components/ui";

export function DevicesView({ me }: { me: ApiUser }) {
    const owner = me.role === "owner";
    const [users, setUsers] = useState<ApiUser[] | null>(owner ? null : [me]);
    const [userId, setUserId] = useState<number>(me.id);
    const [devices, setDevices] = useState<ApiDevice[] | null>(null);
    const [name, setName] = useState("");
    const [rename, setRename] = useState<Record<number, string>>({});
    const [issuedToken, setIssuedToken] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const userOptions = useMemo(
        () =>
            (users ?? []).sort((a, b) => a.username.localeCompare(b.username)),
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

    const reloadDevices = useCallback(async () => {
        try {
            const list =
                userId === me.id
                    ? (await api.me()).devices
                    : await api.listUserDevices(userId);
            setDevices(list);
        } catch (err) {
            setError(errorMessage(err));
            setDevices(null);
        }
    }, [userId, me.id]);

    useEffect(() => {
        void reloadUsers();
    }, [reloadUsers]);

    useEffect(() => {
        setDevices(null);
        void reloadDevices();
    }, [reloadDevices]);

    const provision = async () => {
        setBusy(true);
        setError(null);
        setIssuedToken(null);
        try {
            const { device } = await api.provisionDevice(name);
            setIssuedToken(device.token);
            setName("");
            await reloadDevices();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const doRename = async (device: ApiDevice) => {
        setError(null);
        try {
            await api.renameDevice(device.id, rename[device.id] ?? device.name);
            await reloadDevices();
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    const revoke = async (device: ApiDevice) => {
        if (!confirm(`Revoke device "${device.name}" (…${device.prefix})?`)) {
            return;
        }
        setError(null);
        try {
            await api.revokeDevice(device.id);
            await reloadDevices();
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    if (devices === null) {
        return <p className="muted">Loading devices…</p>;
    }

    return (
        <div className="page">
            <h1>Devices</h1>
            <ErrorBanner>{error}</ErrorBanner>
            {issuedToken ? (
                <InfoBanner>
                    Provisioned. The token below is shown once and then
                    forgotten by the server — copy it now.
                    <Copyable text={issuedToken} />
                </InfoBanner>
            ) : null}

            <section className="panel">
                <h2>Add a device</h2>
                <Form onSubmit={() => void provision()}>
                    <Field
                        label="Device name"
                        value={name}
                        onChange={setName}
                        placeholder="e.g. phone, tablet"
                        required
                    />
                    <SubmitButton disabled={busy}>
                        {busy ? "Provisioning…" : "Provision"}
                    </SubmitButton>
                </Form>
            </section>

            <section className="panel">
                <h2>Device credentials</h2>
                {owner ? (
                    <label className="field">
                        <span>Showing devices for</span>
                        <select
                            value={userId}
                            onChange={(e) => setUserId(Number(e.target.value))}
                        >
                            {userOptions.map((user) => (
                                <option key={user.id} value={user.id}>
                                    {user.username}
                                </option>
                            ))}
                        </select>
                    </label>
                ) : null}
                {devices.length === 0 ? (
                    <p className="muted">No devices.</p>
                ) : (
                    <table className="grid">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Prefix</th>
                                <th>Created</th>
                                <th>Last seen</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {devices.map((device) => (
                                <tr key={device.id}>
                                    <td>
                                        <input
                                            className="inline"
                                            value={
                                                rename[device.id] ?? device.name
                                            }
                                            onChange={(e) =>
                                                setRename((prev) => ({
                                                    ...prev,
                                                    [device.id]: e.target.value,
                                                }))
                                            }
                                        />
                                    </td>
                                    <td title={String(device.id)}>
                                        …{device.prefix}
                                    </td>
                                    <td>
                                        {new Date(
                                            device.createdAt,
                                        ).toLocaleString()}
                                    </td>
                                    <td>
                                        {device.lastSeenAt
                                            ? new Date(
                                                  device.lastSeenAt,
                                              ).toLocaleString()
                                            : "never"}
                                    </td>
                                    <td className="actions">
                                        <Button
                                            variant="ghost"
                                            disabled={
                                                (rename[device.id] ??
                                                    device.name) === device.name
                                            }
                                            onClick={() =>
                                                void doRename(device)
                                            }
                                        >
                                            Save
                                        </Button>
                                        <Button
                                            variant="danger"
                                            onClick={() => void revoke(device)}
                                        >
                                            Revoke
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    );
}
