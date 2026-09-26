# REST endpoint table

Source of truth: `spec/openapi.yaml` (regenerate with
`npm run docs:endpoints` from `packages/contracts`).

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/health` | none | Machine health check |
| `POST` | `/api/bootstrap` | x-bootstrap-token header | Bootstrap the first-owner account |
| `POST` | `/api/auth/login` | none | Log in with username and password for a device token |
| `POST` | `/api/session` | none | Log in with username and password for a cookie session |
| `GET` | `/api/session` | device token or web session | Echo the current session identity |
| `DELETE` | `/api/session` | device token or web session | End the current cookie session |
| `GET` | `/api/me` | device token or web session | Current user and their devices |
| `POST` | `/api/devices` | device token or web session | Provision a new device token |
| `PATCH` | `/api/devices/{id}` | device token or web session | Rename a device |
| `DELETE` | `/api/devices/{id}` | device token or web session | Revoke a device |
| `GET` | `/api/users` | device token or web session | List accounts |
| `POST` | `/api/users` | device token or web session | Create an account |
| `PATCH` | `/api/users/{id}` | device token or web session | Update an account role or disabled flag |
| `GET` | `/api/users/{id}/devices` | device token or web session | List another account's devices |
| `GET` | `/api/users/{id}/prefs` | device token or web session | Read another account's preferences |
| `PUT` | `/api/users/{id}/prefs` | device token or web session | Upsert another account's preferences |
| `DELETE` | `/api/users/{id}/prefs` | device token or web session | Clear another account's preferences |
| `GET` | `/api/prefs` | device token or web session | Read the caller's preferences |
| `PUT` | `/api/prefs` | device token or web session | Upsert the caller's preferences |
| `DELETE` | `/api/prefs` | device token or web session | Clear the caller's preferences |
| `GET` | `/api/sessions` | device token or web session | List chat-thread sessions |
| `DELETE` | `/api/sessions/{threadId}` | device token or web session | Delete a chat-thread session |
