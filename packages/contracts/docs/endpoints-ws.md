# WebSocket channel table

Source of truth: `spec/asyncapi.yaml` (regenerate with
`npm run docs:endpoints` from `packages/contracts`).

| Operation | Action | Messages | Summary |
| --------- | ------ | -------- | ------- |
| `sendClientFrame` | send | clientHello, authHandshake, chatPrompt, locationFrame, cancelFrame | Auth handshake, capability announcement, location report, chat prompt, or turn cancellation |
| `receiveServerFrame` | receive | authResult, chunk, toolCall, toolResult, done, error, audioStart, audioEnd, pcmChunk | Streamed agent events, terminal `done`, or errors |
