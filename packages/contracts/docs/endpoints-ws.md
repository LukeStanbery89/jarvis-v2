# WebSocket channel table

Source of truth: `spec/asyncapi.yaml` (regenerate with
`npm run docs:endpoints` from `packages/contracts`).

| Operation | Action | Messages | Summary |
| --------- | ------ | -------- | ------- |
| `sendClientFrame` | send | clientHello, authHandshake, chatPrompt, locationFrame | Auth handshake, capability announcement, location report, or chat prompt |
| `receiveServerFrame` | receive | authResult, chunk, toolCall, toolResult, done, error, audioStart, audioEnd, pcmChunk | Streamed agent events, terminal `done`, or errors |
