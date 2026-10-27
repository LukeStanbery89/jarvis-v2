# REST endpoint table

Source of truth: `spec/openapi.yaml` (regenerate with
`npm run docs:endpoints` from `packages/contracts`).

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/health` | none | Machine health check |
| `POST` | `/api/attachments` | device token or web session | Upload an image for analysis in a chat prompt |
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
| `GET` | `/api/push/key` | device token or web session | Read the Web Push VAPID public key |
| `POST` | `/api/push/subscribe` | device token or web session | Register this browser for Web Push |
| `POST` | `/api/push/unsubscribe` | device token or web session | Remove this browser's Web Push registration |
| `GET` | `/api/weather` | device token or web session | Current weather for device coordinates |
| `GET` | `/api/sessions` | device token or web session | List chat-thread sessions |
| `GET` | `/api/sessions/{threadId}` | device token or web session | Read one chat-thread transcript page |
| `DELETE` | `/api/sessions/{threadId}` | device token or web session | Delete a chat-thread session |
| `GET` | `/api/stt/model` | none | Download the local speech-recognition model archive |
| `GET` | `/api/wake/model/{file}` | none | Download a local wake-word model file |
| `GET` | `/api/notifications` | device token or web session | List the caller's notifications |
| `POST` | `/api/notifications` | device token or web session | Raise a notification for the caller |
| `POST` | `/api/notifications/{id}/read` | device token or web session | Mark a notification read |
| `POST` | `/api/notifications/{id}/dismiss` | device token or web session | Dismiss a notification |
| `POST` | `/api/notifications/{id}/answer` | device token or web session | Answer a notification that asked a question |
| `GET` | `/api/coding-jobs/{id}/logs` | device token or web session | Follow one coding job's log |
| `GET` | `/api/coding-jobs/{id}/questions` | device token or web session | Read a coding job's questions and answers |
| `GET` | `/api/jobs` | device token or web session | List the caller's scheduled jobs |
| `POST` | `/api/jobs` | device token or web session | Schedule a job for the caller |
| `GET` | `/api/jobs/{id}` | device token or web session | One job and its run history |
| `PATCH` | `/api/jobs/{id}` | device token or web session | Edit a pending job |
| `DELETE` | `/api/jobs/{id}` | device token or web session | Cancel a pending job |
| `POST` | `/api/jobs/{id}/snooze` | device token or web session | Snooze a reminder |
