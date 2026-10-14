# #110 — Extract `BargeWatch` / `WakeManager` from `VoiceController`

## Goal

Reduce `packages/voice/src/controller.ts` to lifecycle + session composition
(target: <700 lines including mandated JSDoc) by lifting the self-contained
feature state machines into their own modules over a minimal shared context.
Behavior and the public API stay identical; the full voice suite (171 cases as
of #104) must stay green with **no test-intent changes**.

## Why

Per the post-#101 audit, the controller carries three independent state
machines whose mic-ownership rules are enforced by three mutually-synchronized
flag pairs — the invariant class the barge start/stop race (#104) slipped
through. The extraction makes the interlocks explicit context APIs instead of
shared privates, and gives each machine its own focused unit suite.

Gated on #104 (landed, commit `d608a4a`) so the race fixes and the split don't
churn each other.

## Target shape

```
packages/voice/src/
  core.ts        VoiceCore context (snapshot/reduce/vad/schedule/unschedule/log/isDisposed/stopVad)
  barge.ts       BargeWatch + BargeInDetection + BARGE_* constants
  wake.ts        WakeManager + DEFAULT_WAKE_PHRASE + wakeReplay helper
  session.ts     VoiceSession + END_OF_SPEECH_MS/NO_SPEECH_MS (endpointing)
  controller.ts  VoiceController: lifecycle, session composition, VAD/wake/barge seams
  index.ts       re-exports moved symbols from their new modules (public API unchanged)
```

```ts
interface VoiceCore {
    snapshot(): VoiceSnapshot;
    reduce(event: VoiceEvent): void;
    readonly vad: VadProvider | null;
    schedule(cb: () => void, ms: number): unknown;
    unschedule(handle: unknown): void;
    log(message: string, error?: unknown): void;
    isDisposed(): boolean;
    stopVad(): Promise<void>;
}

class BargeWatch {
    start(): Promise<void>;
    stop(): Promise<void>;
    dispose(): void;
    get active(): boolean;
    /** The in-flight VAD release, for `begin()` to await. */
    stopping(): Promise<void> | null;
}

class WakeManager {
    enable(): Promise<void>;
    disable(): Promise<void>;
    disarmForSession(): void;
    maybeReArm(): void;
    drainPostMatch(): Float32Array | null;
    dispose(): Promise<void>;
}
```

## Interlocks (the whole point)

- `pendingReArm` / `wakeBusy` become `WakeManager` privates; the controller
  calls `wake.maybeReArm()` from `reduce()` when a session lands `idle`.
- `bargeStopping` becomes `BargeWatch.stopping()`; `begin()` awaits it.
- Both managers receive a controller callback to open a session
  (`BargeWatch.onDetected(feed)` / `WakeManager.onMatch(detection)`), so no
  manager reaches back into the controller's `begin()`.

## Phases (each stops for manual testing)

### Phase A — `BargeWatch`

- Add `core.ts` (`VoiceCore`) and `barge.ts` (`BargeWatch`, `BargeInDetection`,
  `BARGE_IN_SPEECH_MS`, `BARGE_IN_LOOKBACK_MS`).
- Controller delegates `startBargeWatch`/`stopBargeWatch`, `begin()`'s stop and
  wait, and `dispose()`'s teardown; `onBargeIn` + open-session move behind a
  `BargeWatch` option pair.
- `index.ts` re-exports the barge constants/type from `./barge` (path change
  only — API identical).
- New `test/barge.test.ts` drives `BargeWatch` over a fake `VoiceCore`.
- Manual: barge-in during playback still hands off cleanly.

### Phase B — `WakeManager`

- Add `wake.ts` (`WakeManager`, `DEFAULT_WAKE_PHRASE`, `wakeReplay`).
- Controller delegates `enableWake`/`disableWake`/`disarmDetectorForSession`/
  `maybeReArm`/`handleWake`/`drainPostMatch`; the cue + `begin({fromWake})` stay
  controller-side behind `WakeManager.onMatch`.
- New `test/wake.test.ts` over a fake `VoiceCore`.
- Manual: wake word opens a session; re-arm after a turn; enable mid-session
  defers.

### Phase C — slim + docs

- Drop now-dead controller privates and fix the orphaned `toVoiceError` JSDoc
  (moved to `src/errors.ts` in Phase B).
- Update the controller header diagram, `index.ts` package doc, and
  `packages/voice/README.md`.

### Phase D — extract `VoiceSession` (endpointing)

Chosen over "keep endpointing in `controller.ts`, accept ~1050 lines": the
session/endpointing cluster moves wholesale into `src/session.ts`
(`VoiceSession`), so `controller.ts` reaches the `<700` target.

- New `VoiceSession` owns one recognition session's engine/VAD callbacks,
  the `END_OF_SPEECH_MS`/`NO_SPEECH_MS` timers, the accumulated finals, and
  submission; the constants move here (re-exported from `index.ts`).
- `begin()` computes the engine, applies the stale-activation guard, arms the
  VAD with `session.vadCallbacks()`, sets `session.setVadOwned(...)`, assigns
  `this.session`, then awaits `session.start(replay)`.
- `press()` listening branch delegates to `session.finish()`; `dispose()`
  calls `session.dispose()`.
- New `test/session.test.ts` (fake `VoiceCore`, scripted STT + timer queue).

## Outcome

Three machines live in their own modules over `VoiceCore`; the controller
keeps lifecycle, session composition, and the wake/barge/VAD seams only.

| File            | Lines |
| --------------- | ----- |
| `controller.ts` | 559   |
| `session.ts`    | 620   |
| `wake.ts`       | 301   |
| `barge.ts`      | 353   |
| `core.ts`       | 38    |
| `errors.ts`     | 35    |

`controller.ts` fell 1393 → 1076 (barge + wake extraction) → **559**
(session/endpointing extraction), meeting the aspirational `<700 incl. JSDoc`
target. `session.ts`'s size is dominated by the endpointing/race JSDoc the
behavior depends on.

## Acceptance (from the issue)

- [x] `BargeWatch` + `WakeManager` extracted over a minimal `VoiceCore`
- [x] `controller.ts` reduced to lifecycle + session composition (559 incl.
      JSDoc, `<700` met)
- [x] Full voice suite green with no test-intent changes (barge/wake/controller
      suites unchanged; 219 tests after the new `session`/`barge`/`wake` units)
- [x] Race-suite re-run: barge start/stop, wake+press, stale watch (#104)
- [x] Public API in `index.ts` unchanged (new classes stay internal)

Closes #110.
