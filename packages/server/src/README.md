# @jarvis/server — src architecture

This README explains how the server's source is organized. It is not a usage
guide — see the package `README.md` for prerequisites, endpoints, and
script commands.

## Directory tree

```
src/
├── index.ts   # entry point (bootstrap + listen)
├── app.ts     # Express app factory (health check)
├── config.ts  # LLM configuration from environment
├── llm.ts     # model token source (LLM → server)
├── ws.ts      # /ws chat endpoint (server → client)
└── README.md  # this file
```

## File map

| File        | Responsibility                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`  | Entry point: builds the Express app, attaches the WS chat server, and listens on `PORT` (default `54321`)                                          |
| `app.ts`    | `createApp()` factory → the Express app serving `GET /` health check. Kept as a factory so tests can mount it via supertest without binding a port |
| `config.ts` | `getLlmConfig()` → the LLM base URL and model, from `LLM_BASE_URL` / `LLM_MODEL` (with LM Studio defaults)                                         |
| `llm.ts`    | `streamLlmResponse(prompt)` → pulls tokens from the OpenAI-compatible inference server (LLM → server direction)                                    |
| `ws.ts`     | `attachChatServer(httpServer)` → the `/ws` chat endpoint; pushes tokens to clients as frames (server → client direction)                           |

## Data flow

```
CLI / WebSocket client
      │  {"prompt": "..."}
      ▼
ws.ts  handleMessage   (parse + validate the prompt frame)
      │  prompt
      ▼
ws.ts  streamTokensToSocket ← streams chunk frames back to the socket
      │  for await ...
      ▼
llm.ts streamLlmResponse    (POST /chat/completions, stream: true)
      │  content deltas
      ▼
LM Studio (OpenAI-compatible server)
```

The boundary between `llm.ts` and `ws.ts` is the seam used by the tests:
`test/ws.test.ts` mocks `streamLlmResponse` so the chat endpoint is exercised
without a live model.

## Key decisions

- **Direction-isolating names.** `streamLlmResponse` moves tokens _out of the
  model_; `streamTokensToSocket` moves them _to a chat client_. Neither name
  is ambiguous about which hop it owns.
- **Prompt history.** The LLM call sends a single user turn — there is no
  conversation context yet. Adding multi-turn memory means threading message
  history into `streamLlmResponse` and the chat protocol.
- **One active response per connection.** A second prompt arriving while a
  response is streaming is rejected with an error frame (see protocol in the
  package README). `active` lives per-connection inside `attachChatServer`,
  so different clients can still stream concurrently.
- **Small LLM surface.** `llm.ts` is the only file that knows the OpenAI SDK.
  Swapping in a different backend means changing just this one layer.
