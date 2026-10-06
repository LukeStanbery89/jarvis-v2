# Plan — #15 LangChain tool: Home Assistant

## Goal

Give the agent one tool that reads and lightly controls the user's Home Assistant
instance, using the same seams the weather (#31) and search (#9) tools established.

## Decisions (confirmed with the requester)

| Decision     | Choice                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transport    | Home Assistant's local REST API + a long-lived access token                                                                                                                                                                                |
| First slice  | Read status **and** basic control (lights, switches, climate)                                                                                                                                                                              |
| Write safety | Execute immediately, reported as **accepted, never verified** (HA's service body is dispatch-time state); the tool description tells the model to confirm ambiguous or destructive asks in words first and to call `get` for current state |
| Tool shape   | **One** tool (`homeAssistant`) with an `action` argument                                                                                                                                                                                   |

## Reference implementation

`modules/rag-tools-server/src/home_assistant/` in the legacy `jarvis` repo. Worth
carrying over:

- `HOME_ASSISTANT_URL` + `HOME_ASSISTANT_ACCESS_TOKEN` env config.
- `GET /api/states` with `Authorization: Bearer …`, filtered by an entity-domain
  allowlist, with `_led` entities dropped.
- `POST /api/services/<domain>/<service>` with `{ entity_id }`.
- **Validate before writing**: refuse a control call for an entity that is not in
  the filtered list, so the model cannot act on a typo or an out-of-scope entity.
- Resolve a friendly name and confirm in model-facing prose
  (`Successfully turned on Kitchen Lamp (light.kitchen).`).
- Memoize the state snapshot (30 s TTL there) to spare both the API and context.

Deliberately **not** carried over:

- A hardcoded LAN IP as the default `serverUrl` (`192.168.86.25:8123`) — that is a
  private address that must not ship as a default; env-only.
- A domain allowlist hardcoded in source (`['switch']`) — env-driven, with the
  control list narrower than the read list.
- `DynamicTool` with a JSON string argument, re-parsed with `JSON.parse` — a zod
  schema, so the model cannot emit an unparseable payload.
- Reassigning the method in the constructor to memoize it — a plain cached field.
- No HTTP timeout and no call quota — both are required here.

## Architecture

```
ws.ts prompt
   │
   ▼
agentGraph (tools node)
   │
   ▼
homeAssistant tool ── quota (FixedWindowQuota, per user) ──┐
   │                                                      │ refuse → model-facing text
   ├─ action: list / get                                  │
   │     └─ provider.entities()  ──► snapshot cache (TTL)  │
   ├─ action: turn_on / turn_off / toggle                 │
   │     └─ validate in filtered snapshot ──► callService │
   └─ action: set_brightness / set_temperature            │
         └─ validate domain supports it ──► callService   │
                                                        │
                                                        ▼
                              HomeAssistantClient (fetch, 10s timeout)
                                        │  GET /api/states
                                        │  POST /api/services/<domain>/<service>
                                        ▼
                        Home Assistant  (http://<host>:8123, Bearer token)
```

The tool holds no HTTP logic and the client holds no model logic — the same split
`tools/weather/openweather.ts` + `tools/getWeather.ts` already use.

## Files

| File                                         | Change                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/llm/tools/homeAssistant/types.ts`       | `HomeAssistantEntity`, `HomeAssistantProvider`, `HomeAssistantError`, `HomeAssistantAction` |
| `src/llm/tools/homeAssistant/client.ts`      | `createHomeAssistantClient` — bounded fetch, defensive parsing, TTL snapshot cache          |
| `src/llm/tools/homeAssistant.ts`             | the tool: quota, action dispatch, pre-write validation, model-facing formatters             |
| `src/config.ts`                              | `HomeAssistantConfig` + env parsing                                                         |
| `src/llm/tools/index.ts`                     | `homeAssistant?: HomeAssistantDeps` on `ToolDeps`; register when present                    |
| `src/index.ts`                               | production wiring + a startup line naming the host and domain lists                         |
| `test/homeAssistant.client.test.ts`          | client parsing, timeout, cache TTL, token never in errors                                   |
| `test/homeAssistant.tool.test.ts`            | quota, action dispatch, validation refusals, formatters                                     |
| `.env.example`, `README.md`, `src/README.md` | env docs, the tool's section, the file-map rows                                             |

No contract change: the tool is internal to the agent, so `packages/contracts` is
untouched (same as #9/#31, which only touched specs for the frames they added).

## Tool contract

```ts
homeAssistant({
    action: "list" | "get" | "turn_on" | "turn_off" | "toggle"
          | "set_brightness" | "set_temperature",
    entity_id?: string,   // required for get / turn_* / toggle / set_*
    query?: string,       // list: name or domain substring filter
    value?: number,       // set_brightness: 0-100; set_temperature: °F or °C
})
```

- `list` is **bounded**: at most 40 entities, alphabetically sorted, with a count
  of what was omitted. A large instance has thousands of states and must never be
  dumped into the model's context.
- `get` returns one entity's state plus the attributes worth showing
  (temperature target, brightness, battery).
- `set_brightness` requires `light.*`; `set_temperature` requires `climate.*`.
  Anything else returns model-facing text naming the requirement.

## Safety

1. **Nothing is written that was not validated.** A control call must name an
   entity present in the domain-filtered snapshot; a typo is refused, not sent.
2. **The control domain list is narrower than the read list.** `sensor` and
   `binary_sensor` are readable but not controllable. `lock`, `cover`, `button`,
   `script` and `scene` are excluded from control entirely — out of scope for the
   first slice.
3. **The token never appears** in a log line, an error message, or model-facing
   text. It lives in one config field and goes out only as a request header.
4. **The model is told to confirm** ambiguous or destructive asks ("turn everything
   off") in words before acting, and never to guess a target.
5. **Per-user quota** (`JARVIS_HA_CALLS_PER_MIN`, default 10) checked before any
   HTTP call, so a runaway model loop cannot hammer the instance.
6. **Writes are logged** at info with entity id and action — an audit trail of
   what the assistant did to the house.
7. **The snapshot cache is invalidated after a write.** The reference never
   invalidates, so after turning a light on, `list` can report it off for up to
   the TTL. **The confirmation line does not come from the service response:**
   Home Assistant's 2xx body reports the entities' states as of _dispatch_ (a
   `turn_off` routinely answers `on`), so reporting it handed the model a
   contradiction it then tried to explain away. The body is discarded, a resolved
   call is the acceptance signal, and the tool says only that the request was
   accepted — the model calls `get` when it needs state. An entity reading
   `unavailable`/`unknown` is refused before the call for the same reason: an
   acknowledgement Home Assistant cannot deliver is not a change.
8. **Temperature values go to Home Assistant in the instance's own unit.** Our
   server's `JARVIS_WEATHER_UNITS` is irrelevant here; HA converts using its
   configured system. `get` therefore surfaces `unit_of_measurement` so the model
   has the unit in front of it instead of guessing.

## Review findings folded into this plan

1. **Cache invalidation on write** (safety 7) — the reference's 30 s stale read
   after a control call is a real bug, not a nitpick: it makes the assistant
   contradict itself one turn later.
2. **Unit ambiguity for `set_temperature`** (safety 8) — cross-unit mistakes
   ("70" meaning °C on a °F instance) set a thermostat to 158 °F. The entity's
   `unit_of_measurement` is surfaced on read, and the tool description says values
   are in the instance's unit.
3. **A write always names exactly one entity** — `entity_id` is required, so
   "turn everything off" cannot be expressed as a single call. That is
   deliberate: the model must enumerate, which is visible and rate-limited, and
   the description tells it to confirm first.
4. **Lock/cover/button are readable but not writable** — reading a lock's state is
   harmless and useful; arming one from an LLM turn is a different risk class and
   waits for its own issue.

## Defaults

| Env                           | Default                                                                 | Notes                       |
| ----------------------------- | ----------------------------------------------------------------------- | --------------------------- |
| `HOME_ASSISTANT_URL`          | —                                                                       | Required. No baked-in IP.   |
| `HOME_ASSISTANT_ACCESS_TOKEN` | —                                                                       | Required. Absent ⇒ no tool. |
| `JARVIS_HA_READ_DOMAINS`      | `light,switch,climate,fan,sensor,binary_sensor,cover,media_player,lock` | Read-only surface           |
| `JARVIS_HA_CONTROL_DOMAINS`   | `light,switch,climate,fan`                                              | The writable subset         |
| `JARVIS_HA_CALLS_PER_MIN`     | `10`                                                                    |                             |
| `JARVIS_HA_TIMEOUT_MS`        | `10000`                                                                 |                             |
| `JARVIS_HA_CACHE_TTL_MS`      | `15000`                                                                 | State snapshot freshness    |
| `JARVIS_HA_LIST_LIMIT`        | `40`                                                                    | Ceiling on `list` output    |

## Test plan

- Client: malformed JSON, missing `friendly_name`, non-array `/api/states`, a 401,
  a 500, a timeout, the cache serving a second call and expiring after the TTL, and
  an assertion that the token appears in no error message. Writes additionally
  assert the response body is discarded — a 2xx whose body is not JSON still
  resolves.
- Tool: quota refusal; each action's routing; `get` on an unknown entity; a control
  call for an out-of-read-list entity; `set_brightness` on a `switch.*`;
  `list` truncation with a count; `list` with a `query` filter; formatter output.
  A write's result contains the accepted action and no state whatsoever, and an
  entity reading `unavailable`/`unknown` refuses without a service call.
- `npm run check` from the repo root.

## Manual verification (before any PR)

1. `HOME_ASSISTANT_URL` + `HOME_ASSISTANT_ACCESS_TOKEN` in `packages/server/.env`.
2. "What lights are on?" → `list`/filtered read.
3. "Turn on the kitchen light" → validated write; the result states the accepted
   action and claims no state. "Is it on now?" → a fresh `get` reports it.
4. "Set the thermostat to 70" → `set_temperature` on a `climate.*`.
5. "Turn on light.kitchn" (typo) → refused, model retries with the right id.

## Out of scope

- Locks, covers, buttons, scripts, scenes, and automations as _write_ targets.
- Home Assistant's conversation/Assist pipeline, MQTT, and Nabu Casa.
- Using Home Assistant's `device_tracker` as a location source for #31.
- Exposing HA over REST/WS to the portal (the agent tool only).
