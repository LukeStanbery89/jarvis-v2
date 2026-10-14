# Plan — #104 Voice: fix first-press/begin/watch races in the controller

## Goal

Close the five real races the post-#101 audit traced through
`packages/voice`, plus two contract-correctness items, without changing the
observable lifecycle contract. The extraction of `BargeWatch`/`WakeManager`
(#110) is deliberately deferred until this lands, so the race fixes and the
split do not churn each other.

## Prerequisite for #110

#110 rewires every timing/seam interlock this issue touches
(`begin()`'s activation guard, the barge-watch generation token, the wake
re-arm deferral). Landing #104 first means #110 extracts settled code.

## Races (verified against source)

### 1. Cold-engine first press dies silently

`controller.ts` arms the `NO_SPEECH_MS` guard **before** `stt.start()`
resolves. Vosk's `start()` awaits the ~40 MB model load, and the web client
never calls `prepare()` on the primary engine, so on Firefox (Vosk = default)
the first-ever press fires the no-speech timeout mid-download: cancel →
settle → the load completes into a dead session. Speech _during_ the load
routes `onSpeechEnd` → end-of-speech timeout → `vosk.stop()` while
`state === "starting"` — the same death.

**Fix:** track a per-session `sessionStarting` flag; arm the silence guard
only after `stt.start()` resolves. While starting, `onSpeechEnd` records
`deferredSpeechEnd` (rather than arming the flush timer) and `onSpeechStart`
/ `onPartial` / `onTranscript` set `heardSpeech`. On start resolve, if still
`listening` on the same session: arm end-of-speech when `deferredSpeechEnd`,
else arm no-speech when `!heardSpeech`. `onEndOfSpeechTimeout` bails while
`sessionStarting` (covers a manual press during the load).

### 2. `begin()` never verifies the activation took

The reducer ignores `activate` when already
`listening`/`transcribing`/`submitting`, but `begin()` proceeds and captures
the _same_ session id. Two consequences: a press in the `onWakeCue` window
opens session N, then the wake's `begin()` captures id N and its
`stt.start` failure path kills the press's live session; and a stale barge
watch firing into a live session cancels the turn.

**Fix:** capture `sessionId` before `reduce({ type: "activate" })`; if it is
unchanged, return before touching any engine.

### 3. Barge-watch start/stop interleave orphans the VAD

`stopBargeWatch()` while `startBargeWatch()` is still awaiting `vad.start()`
early-returns (the watch is not yet active), then the start continuation arms
it with no one left to stop it → the next session's `vad.start()` throws and
sustained speech later fires `onBargeIn` against a turn that is not playing.

**Fix:** the `initSeq` generation-token pattern already used in
`providers/openWakeWord.ts`. `start` captures `++seq`; on the resolve side of
`vad.start()` a mismatched seq means a `stop()` superseded it, so it releases
the VAD it just armed. `stop` bumps the seq and funnels its release through
`bargeStopping` (the interlock `begin()` already awaits).

### 4. `vosk.dispose()` during an in-flight load resurrects the model

The load chain's `.then` assigns `this.model` after `dispose()` nulls it; the
worker is never terminated and a later `start()` reuses the "disposed"
worker.

**Fix:** a `loadGeneration` counter. `dispose()` bumps it; the load chain's
`.then` checks it, terminates the late model, and rejects instead of caching
it. A subsequent `start()` reloads from the (browser-persistent) cache.

### 5. `onBargeIn` rejection is an unhandled rejection

The `try/catch` around `onBargeIn` only catches synchronous throws. A
rejected callback surfaces as a browser unhandled-rejection error even though
the session survives.

**Fix:** route the returned promise through `.catch(...)` into the injectable
`log` sink.

### 6. Mid-session `enableWake()` arms a second microphone

`enableWake()` calls `armWake()` regardless of session state, so a toggle
mid-session arms the detector alongside the session mic until the next
`begin()`.

**Fix:** when `snapshot.state !== "idle"`, set `pendingReArm = true` and
return; `maybeReArm()` arms when the session lands `idle`.

### 7. `WakeDetection` hardcodes the 16 kHz look-back convention

`BargeInDetection` carries `lookbackSampleRate` explicitly; the wake path
assumes 16000.

**Fix:** add `lookbackSampleRate?: number` to `WakeDetection`, supply `16000`
from `openWakeWord.ts`, and thread it through `begin`'s wake replay.

## Contract/docs items

- Correct the `wakeStt` JSDoc: wake support **requires** it; the
  `this.wakeStt ?? this.stt` fallback in `begin()` is unreachable for wake
  sessions.
- Confirm the injectable `log?` seam is wired at the five silent decision
  points (VAD-start degradation, barge-watch arm failure, `wakeStt.prepare()`
  failure are already wired; add the vosk cancellation traces if missing).

## Test plan

Added to the existing suites (no intent changes to current assertions):

- `controller.test.ts`: cold engine (a `start()` whose promise the test
  resolves by hand) + speech during load survives and endpoints normally after
  the resolve.
- `controller.wake.test.ts`: wake+press race — the ignored `begin()` does not
  disturb the press session; mid-session `enableWake()` defers arming; wake
  replay uses the reported look-back rate.
- `controller.barge.test.ts`: an interleaved `start`/`stop` leaves nothing
  armed; a watch firing into a live session does not open a second session;
  an async `onBargeIn` rejection is handled (no unhandled rejection).
- `vosk.test.ts`: `dispose()` during an in-flight model load terminates the
  late worker; a subsequent `start()` loads a fresh one.

## Acceptance (from the issue)

- [ ] Silence guard armed only after `stt.start()` resolves; end-of-speech
      flush skipped while starting.
- [ ] `begin()` no-ops unless the activation took.
- [ ] Barge watch start/stop interleave leaves nothing armed.
- [ ] `dispose()` during load terminates the late worker.
- [ ] `onBargeIn` rejection handled.
- [ ] Mid-session `enableWake()` defers arming.
- [ ] `lookbackSampleRate` on `WakeDetection`; controller uses it.
- [ ] `wakeStt` JSDoc matches behavior; `log?` seam wired.
- [ ] Full voice suite green; web typecheck after voice rebuild.

## Verification

`npm run check` from the repo root (deps + lint + build + typecheck + test +
format), plus `npm run typecheck` in `packages/web` after the voice rebuild.

## Out of scope

- The `BargeWatch`/`WakeManager` extraction (#110) — this issue only fixes the
  seams it will later move.
- Any behavior change to the documented lifecycle.
