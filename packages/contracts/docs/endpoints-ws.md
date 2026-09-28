# WebSocket channel table

Source of truth: `spec/asyncapi.yaml` (regenerate with
`npm run docs:endpoints` from `packages/contracts`).

| Operation | Action | Messages | Summary |
| --------- | ------ | -------- | ------- |
| `sendClientFrame` | send | clientHello, authHandshake, chatPrompt | Auth handshake, capability announcement, or chat prompt |
| `receiveServerFrame` | receive | authResult, chunk, toolCall, toolResult, done, error | Streamed agent events, terminal `done`, or errors |
