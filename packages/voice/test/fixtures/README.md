# Wake→command corpus (issue #121)

Audio fixtures the wake→command path is verified against. The redesign's
acceptance gate is "replayed recordings of real utterances transcribe clean"
(#121, lesson 3) — these files are that gate's data.

## Layout

| Path     | Provenance                               | Committed           |
| -------- | ---------------------------------------- | ------------------- |
| `*.wav`  | Synthetic, macOS `say`                   | yes                 |
| `real/`  | Real recordings (the maintainer's voice) | yes                 |
| `local/` | Anything private — a scratch area        | **no** (gitignored) |

The Tier A corpus test (`test/wakeCorpus.test.ts`) decodes all of it with the
package's dependency-free WAV codec, so everything committed is **16 kHz mono
16-bit PCM WAV**. The browser harness (`/web/?voice-harness=1`) decodes
anything the browser supports — an iPhone voice memo's `.m4a` can be replayed
as-is, without conversion.

## Synthetic fixtures (`*.wav`)

Generated from text with macOS `say` (a _synthetic_ speaker — no personal
data). Regenerate with `npm run fixtures` from this package; see
`scripts/make-fixtures.mjs` for the exact text and provenance.

| File                     | Shape                                                | Why it exists                                                                                                                             |
| ------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `one-breath.wav`         | "Hey Jarvis, turn on the living room light"          | Phrase + command in one breath — the case the look-back ring was added to protect, and the one where clipping the first word is the risk. |
| `pause-then-command.wav` | "Hey Jarvis" + 900 ms silence + "what's the weather" | The 2026-10-14 failure shape: the pause the ASR hallucinated over ("he during a journalist …").                                           |
| `phrase-only.wav`        | "Hey Jarvis"                                         | Waking and saying nothing must submit no prompt.                                                                                          |
| `command-only.wav`       | "what's the weather"                                 | Drives the STT directly, with no detector match, for transcription-quality checks.                                                        |
| `silence.wav`            | 1.5 s of silence                                     | Pure silence before/without speech must submit no prompt.                                                                                 |

## Real recordings (`real/`)

The same five shapes recorded in the maintainer's voice on an iPhone (48 kHz
AAC), converted to 16 kHz mono WAV so the Node corpus test can decode them.
They are committed **deliberately**: the 2026-10-14 failure is an ASR mangling
of real acoustics (a token inserted over the pause) that synthetic speech does
not produce, so only a real recording can reproduce the class the redesign
exists to eliminate. The recordings are the maintainer's own speech, published
in a public repository by the maintainer's decision; a contributor who does
not want to publish a recording uses `local/` instead.
`real/pause-then-command.wav` carries a genuine ~1.2 s quiet gap between the
phrase and the command (asserted from the audio by `findPause` in the corpus
test) — the failure's exact shape.

## What the corpus has shown (#121 phase 1)

Replayed through the real local Vosk engine (`?voice-harness=1`), the
**synthetic** set transcribes cleanly in _both_ columns, including today's
"full" one:

| fixture              | full (phrase + pause)                                                             | post-match              |
| -------------------- | --------------------------------------------------------------------------------- | ----------------------- |
| `pause-then-command` | `"they jarvis what's the weather"` → `"what's the weather"`                       | `"what's the weather"`  |
| `one-breath`         | `"they jarvis turn on the living room light"` → `"turn on the living room light"` | same                    |
| `phrase-only`        | `"they jarvis"` → `""` (no prompt)                                                | (shorter than the skip) |

Synthetic audio mangles the phrase into a **clean one-token** form (`"they
jarvis"`), which the fuzzy stripper handles — which is why the real set
exists.

The real recordings then exposed the actual defect, which no `full`-clip run
could show because it lives in the **splice**, not in the transcription: the
detector's buffer was never emptied at the match, so the controller joined the
match-time window with the buffer drained at session open and fed the phrase
to the engine **twice** (verified in production: `raw="hey jarvis hey jarvis
what's the weather"`, `submitted="hey jarvis what's the weather"` — see #121).
Phase 2 stage A emptied the buffer at the match (asserted by
`test/wakeCorpus.test.ts` and `test/openWakeWord.test.ts`); the section below
is what the production re-test of that change showed.

Two harness-side lessons remain, both recorded in
`packages/web/src/dev/VoiceHarness.tsx`: feeding a whole clip faster than the
worker decodes silently truncates the utterance's tail at flush time, and the
provider's 300 ms flush deadline assumes an empty queue (fine live, wrong for a
lump of replayed audio).

## What the corpus has shown (#121 phase 2)

Stage A — the buffer emptied at the match, the session seeded with post-match
audio only — removed the reported defect on **real production audio**: six wake
turns, no doubled phrase, no stray "Hey JARVIS" in any prompt, and the
pause-then-command shape clean (`raw="what's the weather"`, `submitted`
identical).

The same run exposed a second, previously-masked failure on the **one-breath**
shape ("Hey JARVIS what time is it", no pause). The command's continuation was
supposed to come from the session's _own_ microphone, which opens a few hundred
milliseconds after the match and the cue — by which time the user has finished
speaking. Two turns produced nothing at all (`session N: no speech detected`)
and one lost the command's opening (`raw="richard is outside please"` for "tell
me what temperature it is outside please"). The duplicated phrase had been
drowning it out.

The resolution is the single-mic design: the detector keeps capturing after the
match and **every frame from then on is the command**, fed live into the wake
engine running `{ source: "external" }` (no microphone of its own). The
engine's own silence detection ends the utterance — an empty final is ignored,
so the pause between the phrase and the command cannot end it early — bounded
by `NO_SPEECH_MS` ("woke up and said nothing") and `MAX_COMMAND_MS` (a command
that never pauses). Nothing is buffered, drained, or spliced, so a one-breath
utterance is captured whole by construction.

`test/wakeCorpus.test.ts` asserts that routing on the committed fixtures
(synthetic and real): the frames the engine receives start at the match, are
contiguous, hold no pre-match speech, and repeat nothing.
`test/openWakeWord.test.ts` pins the stream itself (frames after the match, and
only after it). The browser harness remains the way to check _transcription
quality_ through the real Vosk engine (`?voice-harness=1`).

## `local/` (not committed)

A gitignored scratch area for recordings that should stay private: raw phone
originals (`local/source/*.m4a`), someone else's voice, or a work-in-progress
take. The harness reads `local/` files like any other; nothing here is
committed.
