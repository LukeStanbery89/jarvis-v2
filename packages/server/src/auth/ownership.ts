/**
 * The single ownership policy for app rows, shared by every caller.
 *
 * Ownership of a ledger row (a session or a device's `userId`) is decided here
 * and nowhere else — previously each call site restated it (the WS prompt
 * guard, the device-revoke handler, and the session-delete handler). Two
 * variants cover the two real policies:
 *
 * - {@link ownsRow} — strict identity: used by the WS session pipeline, where
 *   even the owner account may only chat on sessions it owns outright.
 * - {@link canManage} — own-or-owner: used by the REST management routes,
 *   where the owner role may act on any account's rows.
 */

/**
 * Strict ownership: `true` when the acting principal's id matches the row's
 * `userId`. Guest principals have no id, so they own only guest rows
 * (`userId = NULL`); an authenticated principal owns exactly its own rows.
 */
export function ownsRow(
    rowUserId: number | null,
    actorUserId: number | null,
): boolean {
    return rowUserId === actorUserId;
}

/**
 * REST management policy: `true` when the acting account owns the row, or
 * holds the `owner` role (which may manage any account's rows). The actor on
 * REST routes is always authenticated, so `actorUserId` is non-null.
 */
export function canManage(
    rowUserId: number | null,
    actorUserId: number,
    actorIsOwner: boolean,
): boolean {
    return rowUserId === actorUserId || actorIsOwner;
}
