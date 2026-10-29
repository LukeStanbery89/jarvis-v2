# @lukestanbery/jarvis-satellite

Headless, mic-first J.A.R.V.I.S. client for macOS and Linux. It is the first
slice of [#240](https://github.com/LukeStanbery89/jarvis-v2/issues/240): a
satellite that wakes on “Hey JARVIS”, captures and transcribes the command
locally, sends a `mode: "voice"` turn over `/ws`, and plays the server’s
streamed TTS reply — with no display or text-chat UI.

> **Phase 1a status:** the wake word is detected in the local Whisper
> transcript, not by openWakeWord yet. Camera capture, echo-cancelled barge-in,
> proactive notification speech, and multi-satellite arbitration are follow-up
> phases in #240. This package is deliberately small enough to put on a Mac or
> Pi and test the audio/auth/TTS path end to end.

## How it works

```text
SoX `rec`                          local Whisper              JARVIS server
────────                          ─────────────              ─────────────
continuous raw PCM ──VAD──▶      Whisper tiny.en  ──text──▶  /ws voice prompt
                                                             │
speaker ◀──WAV── `afplay`/`aplay` ◀──PCM s16le──  Kokoro TTS ◀┘
```

- **Capture:** one SoX `rec` stays open for the life of the wake loop and
  writes raw PCM. An energy segmenter keeps a pre-roll ring, starts an utterance
  150 ms after speech begins, and ends it after trailing silence. Because the
  mic is already running, “Hey JARVIS …” is captured from its first phoneme.
- **Wake:** the transcript is checked with the shared
  `stripWakePhrase` matcher from `@lukestanbery/jarvis-voice`; “Hey JARVIS”,
  “he jarvis”, and “Jarvis, …” all work. If the wake word arrives as its own
  utterance, the next utterance within `JARVIS_SATELLITE_WAKE_FOLLOWUP_MS` is
  treated as the command, so a natural pause does not lose it.
- **Follow-up:** after JARVIS finishes a reply, the next utterance within
  `JARVIS_SATELLITE_CONVERSATION_FOLLOWUP_MS` (3 seconds by default) is accepted
  without the wake phrase. The window opens only after playback ends, and it is
  checked at speech onset, so an utterance that starts inside the window is
  accepted even if Whisper finishes after it expires. Set it to `0` to require
  “Hey JARVIS” every time.
- **Barge-in:** while playback is running, a louder energy detector watches for
  sustained speech. When it fires, the player is stopped, the last
  `JARVIS_SATELLITE_BARGE_IN_PREROLL_MS` of audio seeds the normal segmenter,
  and the interrupting utterance becomes the next command. There is no browser
  echo cancellation on the SoX path, so the barge threshold is higher than the
  wake VAD and can be tuned or disabled.
- **STT:** Transformers.js runs Whisper tiny.en on CPU, cached under
  `~/.jarvis/satellite/models`.
- **Transport:** `ws` connects to `/ws`, authenticates with a device token,
  declares `audio`, and sends `mode: "voice"` prompts. Text frames are parsed
  by `@lukestanbery/jarvis-protocol`.
- **Playback:** the server’s mono `pcm_s16le` stream is wrapped in a WAV and
  played with `afplay` (macOS) or `aplay`/SoX `play` (Linux).

## Prerequisites

- Node.js 24+
- SoX (`brew install sox` on macOS; `sudo apt install sox` on Debian/Pi OS)
- A working microphone and speaker
- A JARVIS server with `JARVIS_TTS_PROVIDER` configured for spoken replies
- A device token, or an existing text-CLI login in
  `~/.jarvis/credentials.json`

The first run downloads the Whisper model (about 40 MB). Plan for that on a
metered connection; later runs use the local cache.

## Build

From the repository root:

```sh
npm install
npm run build -w @lukestanbery/jarvis-satellite
```

## Try it

Start with the checks that do not need the microphone:

```sh
# 1. Tools, token, and server handshake
JARVIS_SERVER_URL=wss://localhost:54321/ws \
JARVIS_SATELLITE_INSECURE_TLS=1 \
npm start -w @lukestanbery/jarvis-satellite -- --check
```

`JARVIS_SATELLITE_INSECURE_TLS=1` is only for the local self-signed dev server.
For a real certificate, omit it or point `JARVIS_SATELLITE_CA` at the CA PEM.

Then test text + TTS without a microphone:

```sh
JARVIS_SERVER_URL=wss://localhost:54321/ws \
JARVIS_SATELLITE_INSECURE_TLS=1 \
npm start -w @lukestanbery/jarvis-satellite -- \
  --text "Say exactly: satellite audio test."
```

Test local STT from a WAV without a microphone:

```sh
say -o /tmp/hey-jarvis.aiff "Hey Jarvis, what is the weather in Chicago?"
sox /tmp/hey-jarvis.aiff -r 16000 -c 1 -b 16 /tmp/hey-jarvis.wav
npm start -w @lukestanbery/jarvis-satellite -- \
  --wav /tmp/hey-jarvis.wav --dry-run
```

Finally, the microphone paths:

```sh
# Push-to-talk: press Enter, wait for "Speak now", speak, pause.
JARVIS_SERVER_URL=wss://localhost:54321/ws \
JARVIS_SATELLITE_INSECURE_TLS=1 \
npm start -w @lukestanbery/jarvis-satellite -- --ptt
# q at the prompt quits; q while recording cancels the capture and exits.

# Wake mode: launch, then say "Hey JARVIS, what is the weather?"
JARVIS_SERVER_URL=wss://localhost:54321/ws \
JARVIS_SATELLITE_INSECURE_TLS=1 \
npm start -w @lukestanbery/jarvis-satellite
# The mic stays open. "Hey JARVIS" followed immediately by the command works;
# a pause after the name also works (the next utterance is the command).
# After a reply, keep talking within 3 seconds to continue without the wake
# phrase (JARVIS_SATELLITE_CONVERSATION_FOLLOWUP_MS).
# q quits in either microphone mode; while recording, q cancels the capture and exits.
```

The first microphone launch may trigger a macOS permission prompt. If it does
not appear, enable **Microphone** for your terminal (or the app that launched
`npm`) under **System Settings → Privacy & Security → Microphone**, then
relaunch. On Linux, check `arecord -l` and the desktop/session audio permissions
for the user running the service.

### No speech captured

SoX uses the macOS **default input device** unless you name one. If the default
is a USB interface or a display without a microphone, `rec` can run forever
without hearing you. List the names:

```sh
sox -V6 -n -t coreaudio list-devices
```

Then pass the one you speak into:

```sh
JARVIS_SATELLITE_INPUT_DEVICE="MacBook Pro Microphone" \
JARVIS_SERVER_URL=wss://localhost:54321/ws \
JARVIS_SATELLITE_INSECURE_TLS=1 \
npm start -w @lukestanbery/jarvis-satellite -- --ptt
```

`--check` prints the configured input, SoX paths, and the visible device names.
You can also change **System Settings → Sound → Input** to the same device if
you prefer the default to work everywhere.

### Wake mode misses the first word or never triggers

Wake mode keeps one SoX stream open and splits it with an energy VAD; it does
not reopen the microphone for each turn. If the first syllable is still clipped,
raise the pre-roll:

```sh
JARVIS_SATELLITE_VAD_PREROLL_MS=1500 \
JARVIS_SATELLITE_VAD_THRESHOLD=0.006 \
JARVIS_SERVER_URL=wss://localhost:54321/ws \
JARVIS_SATELLITE_INSECURE_TLS=1 \
npm start -w @lukestanbery/jarvis-satellite
```

If no `You:` line appears when you speak, lower
`JARVIS_SATELLITE_VAD_THRESHOLD` (for example `0.005`); if room noise wakes it,
raise it. A Bluetooth headset can take a moment to switch to its microphone
profile when the stream opens, but because the stream stays open for the whole
wake loop, that switch only happens once at launch, not on every sentence.

### Barge-in does not trigger, or stops on its own

Barge-in is energy-based on the SoX path; there is no browser echo cancellation.
If the reply's own output is triggering it, raise the threshold:

```sh
JARVIS_SATELLITE_BARGE_IN_THRESHOLD=0.06 \
JARVIS_SERVER_URL=wss://localhost:54321/ws \
JARVIS_SATELLITE_INSECURE_TLS=1 \
npm start -w @lukestanbery/jarvis-satellite
```

If it does not trigger when you interrupt, lower it (for example `0.02`) or
disable it entirely with `JARVIS_SATELLITE_BARGE_IN=0`. The detector requires
300 ms of speech by default; `JARVIS_SATELLITE_BARGE_IN_MS` controls that.

Useful debugging:

```sh
JARVIS_LOG_LEVEL=debug \
npm run start:dev -w @lukestanbery/jarvis-satellite
```

`npm run dev` (TypeScript source) and `npm run start:dev` (built `dist/`) both
set `NODE_ENV=development`, so `Heard command` is rendered verbatim instead of
`[REDACTED]`. Normal `npm start` stays redacted. `JARVIS_LOG_SENSITIVE=full`
overrides the mode for a single run.

If the server is configured without TTS, or the Kokoro engine fails, add
`JARVIS_SATELLITE_LOCAL_TTS=1` to have macOS `say` (or Linux `espeak`) speak the
text locally. That is a fallback, not the normal JARVIS voice.

## Authentication

The satellite does not ask for a password. It uses, in order:

1. `JARVIS_SATELLITE_TOKEN` — a device token, for a service unit or a headless
   Pi.
2. The same `~/.jarvis/credentials.json` the text CLI writes. If the token was
   stored under an `http://host` key, the satellite also tries the matching
   `https://host` key (the local dev server moved to TLS).
3. Nothing — a guest socket. Guest turns are ephemeral; use a token for a
   persistent satellite thread.

To create a token with the text CLI against the local TLS dev server:

```sh
JARVIS_SERVER_URL=wss://localhost:54321/ws \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
npm run dev -w @lukestanbery/jarvis-cli

# at the prompt:
login
```

If the CLI reports `could not reach http://localhost:54321`, it is using its
plain-`ws://` default against the HTTPS server. Use the `wss://` URL above;
`NODE_TLS_REJECT_UNAUTHORIZED=0` is only for the local self-signed certificate.
The satellite finds the resulting `https://localhost:54321` credential entry
automatically.

Or provision a device in the admin portal and copy its one-time token into
`JARVIS_SATELLITE_TOKEN`.

The token is never logged. The satellite only reads the credential file; it
does not rotate or rewrite it.

## CLI modes

| Flag              | Behavior                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| _(none)_          | Wake loop: continuous capture, energy VAD, Whisper; “Hey JARVIS” sends the rest, then a 3 s follow-up window. `q` quits. |
| `--ptt`           | Press Enter for one utterance; `q` quits (or cancels an active capture).                                                 |
| `--once`          | Exit after one completed turn.                                                                                           |
| `--dry-run`       | Transcribe but do not send (mic or `--wav`).                                                                             |
| `--wav <file>`    | Transcribe a WAV and send it; no microphone required.                                                                    |
| `--text <prompt>` | Send a voice-mode text prompt; tests auth/TTS/playback.                                                                  |
| `--check`         | Tools, token, and server handshake; no mic, no STT load.                                                                 |
| `-h`, `--help`    | The flag summary.                                                                                                        |

## Configuration

| Variable                                    | Default                          | Purpose                                                                     |
| ------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `JARVIS_SERVER_URL`                         | `wss://localhost:54321/ws`       | `/ws` endpoint. Use `ws://` only on a trusted plain-HTTP dev server.        |
| `JARVIS_SATELLITE_TOKEN`                    | _(unset)_                        | Device token; overrides the credentials file.                               |
| `JARVIS_SATELLITE_INSECURE_TLS`             | `0`                              | Disable certificate verification for a local self-signed server.            |
| `JARVIS_SATELLITE_CA`                       | _(unset)_                        | PEM CA bundle for a private certificate.                                    |
| `JARVIS_SATELLITE_STATE_DIR`                | `~/.jarvis/satellite`            | Private state root.                                                         |
| `JARVIS_SATELLITE_MODEL_DIR`                | `<state>/models`                 | Whisper cache.                                                              |
| `JARVIS_SATELLITE_INPUT_DEVICE`             | _(system default)_               | SoX input name, e.g. `MacBook Pro Microphone` or `Anker PowerConf C200`.    |
| `JARVIS_SATELLITE_STT_MODEL`                | `onnx-community/whisper-tiny.en` | Transformers.js model id.                                                   |
| `JARVIS_SATELLITE_STT_DTYPE`                | `q8`                             | Model quantization.                                                         |
| `JARVIS_SATELLITE_SESSION_ID`               | _(persisted)_                    | Fixed voice thread id.                                                      |
| `JARVIS_SATELLITE_SESSION_FILE`             | `<state>/sessions.json`          | Thread id store.                                                            |
| `JARVIS_SATELLITE_ONSET_SECONDS`            | `0.3`                            | Speech needed before SoX starts recording.                                  |
| `JARVIS_SATELLITE_SILENCE_SECONDS`          | `0.9`                            | Trailing silence that ends an utterance.                                    |
| `JARVIS_SATELLITE_SILENCE_THRESHOLD`        | `1%`                             | SoX silence threshold.                                                      |
| `JARVIS_SATELLITE_MAX_UTTERANCE_SECONDS`    | `12`                             | Hard cap on one utterance.                                                  |
| `JARVIS_SATELLITE_RECORD_TIMEOUT_MS`        | `20000`                          | Push-to-talk wait-for-speech cap.                                           |
| `JARVIS_SATELLITE_PTT_LEAD_MS`              | `600`                            | Delay after opening the mic before the “Speak now” cue (Bluetooth switch).  |
| `JARVIS_SATELLITE_VAD_THRESHOLD`            | `0.01`                           | Wake-capture RMS threshold; lower it for a quiet microphone.                |
| `JARVIS_SATELLITE_VAD_ONSET_MS`             | `150`                            | Speech needed before the wake segmenter starts an utterance.                |
| `JARVIS_SATELLITE_VAD_SILENCE_MS`           | `800`                            | Trailing silence that ends a wake utterance.                                |
| `JARVIS_SATELLITE_VAD_PREROLL_MS`           | `1000`                           | Audio retained before onset, so the first phoneme is not clipped.           |
| `JARVIS_SATELLITE_VAD_MAX_UTTERANCE_MS`     | `15000`                          | Hard cap on one wake utterance.                                             |
| `JARVIS_SATELLITE_WAKE_FOLLOWUP_MS`         | `5000`                           | Window after a wake-only utterance for the command.                         |
| `JARVIS_SATELLITE_CONVERSATION_FOLLOWUP_MS` | `3000`                           | Window after a reply for a follow-up without the wake phrase; `0` disables. |
| `JARVIS_SATELLITE_BARGE_IN`                 | `1`                              | Set to `0` to disable spoken interruption during playback.                  |
| `JARVIS_SATELLITE_BARGE_IN_THRESHOLD`       | `0.035`                          | RMS needed to consider speech a barge-in; higher than the wake VAD.         |
| `JARVIS_SATELLITE_BARGE_IN_MS`              | `300`                            | Sustained speech needed before playback stops.                              |
| `JARVIS_SATELLITE_BARGE_IN_PREROLL_MS`      | `500`                            | Audio kept before the barge trigger to seed the interrupting command.       |
| `JARVIS_SATELLITE_LOCAL_TTS`                | `0`                              | Speak with macOS `say`/Linux `espeak` when the server sends no audio.       |
| `JARVIS_SATELLITE_CONNECT_TIMEOUT_MS`       | `5000`                           | Connect timeout.                                                            |
| `JARVIS_SATELLITE_AUTH_TIMEOUT_MS`          | `5000`                           | Auth handshake timeout.                                                     |
| `JARVIS_CREDENTIALS_FILE`                   | `~/.jarvis/credentials.json`     | Shared text-CLI credential store.                                           |
| `JARVIS_LOG_LEVEL`                          | `info`                           | `debug`, `info`, `warn`, `error`, `silent`.                                 |

## Security notes

- Raw microphone audio never leaves the device; only the final transcript is
  sent.
- The device token is read from a `0600` file or the environment and is never
  printed. Use TLS (`wss://`) whenever the server is not on localhost.
- `JARVIS_SATELLITE_INSECURE_TLS=1` is a local-development escape hatch, not a
  deployment setting.
- The local transcript is printed to stdout as the satellite’s “you” line and
  is sent to the server as a normal chat prompt. It is not written to a log
  unless the logger is in development mode (`NODE_ENV=development`, which
  `npm run dev` / `npm run start:dev` set) or `JARVIS_LOG_SENSITIVE=full` is
  enabled.

## Not in this slice

- openWakeWord (the transcript-based wake path is the stand-in).
- Camera capture.
- Echo cancellation for barge-in; the satellite uses an energy threshold.
- Spoken timer/reminder notifications.
- Multi-satellite claim arbitration.
- A systemd/launchd installer (the README gives the runtime shape; service
  samples land with phase 1).

See [#240](https://github.com/LukeStanbery89/jarvis-v2/issues/240) for the
full roadmap.
