# WebSocket channel table

Source of truth: `spec/asyncapi.yaml` (regenerate with
`npm run docs:endpoints` from `packages/contracts`).

| Operation | Action | Messages | Summary |
| --------- | ------ | -------- | ------- |
| `sendClientFrame` | send | authHandshake, chatPrompt | Auth handshake (optional first frame) or chat prompt |
| `receiveServerFrame` | receive | authResult, chunk, toolCall, toolResult, done, error | Streamed agent events, terminal `done`, or errors |
