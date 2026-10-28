# @lukestanbery/jarvis-satellite

Headless, mic-first J.A.R.V.I.S. client for macOS and Linux. It is the first
slice of [#240](https://github.com/LukeStanbery89/jarvis-v2/issues/240): a
satellite that wakes on “Hey JARVIS”, captures and transcribes the command
locally, sends a `mode: "voice"` turn over `/ws`, and plays the server’s
streamed TTS reply — with no display or text-chat UI.

> **Phase 1a status:** the wake word is detected in the local Whisper
> transcript, not by openWakeWord yet. Camera capture, barge-in, proactive
> notification speech, and multi-satellite arbitration are follow-up phases in
> #240. This package is deliberately small enough to put on a Mac or Pi and
> test the audio/auth/TTS path end to end.

## How it works

```text
SoX `rec`                         local Whisper              JARVIS server
────────                         ─────────────              ─────────────
silence-segmented mic ──WAV──▶  Whisper tiny.en  ──text──▶  /ws voice prompt
                                                             │
speaker ◀──WAV── `afplay`/`aplay` ◀──PCM s16le──  Kokoro TTS ◀┘
```

- **Capture:** SoX `rec` starts on speech and stops after trailing silence, so
  the daemon is not recording silence forever. Audio stays on the device.
- **Wake:** the transcript is checked with the shared
  `stripWakePhrase` matcher from `@lukestanbery/jarvis-voice`; “Hey JARVIS”,
  “he jarvis”, and “Jarvis, …” all work.
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

````sh
# Push-to-talk: press Enter, wait for "Speak now", speak, pause.
JARVIS_SERVER_URL=wss://localhost:54321/ws \
JARVIS_SATELLITE_INSECURE_TLS=1 \
npm start -w @lukestanbery/jarvis-satellite -- --ptt
# q at the prompt quits; q while recording cancels the capture and exits.

# Wake mode: launch, then say "Hey JARVIS, what is the weather?"
JARVIS_SERVER_URL=wss://localhost:54321/ws \
JARVIS_SATELLITE_INSECURE_TLS=1 \
npm start -w @lukestanbery/jarvis-satellite
# q quits in either microphone mode; while recording, q cancels the capture and exits.```

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

Useful debugging:

```sh
JARVIS_LOG_LEVEL=debug \
JARVIS_LOG_SENSITIVE=full \
npm start -w @lukestanbery/jarvis-satellite
````

`JARVIS_LOG_SENSITIVE=full` prints the transcript; leave it off outside local
debugging.

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

| Flag              | Behavior                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------- |
| _(none)_          | Wake loop: SoX segments speech, Whisper transcribes, “Hey JARVIS” sends the rest. `q` quits. |
| `--ptt`           | Press Enter for one utterance; `q` quits (or cancels an active capture).                     |
| `--once`          | Exit after one completed turn.                                                               |
| `--dry-run`       | Transcribe but do not send (mic or `--wav`).                                                 |
| `--wav <file>`    | Transcribe a WAV and send it; no microphone required.                                        |
| `--text <prompt>` | Send a voice-mode text prompt; tests auth/TTS/playback.                                      |
| `--check`         | Tools, token, and server handshake; no mic, no STT load.                                     |
| `-h`, `--help`    | The flag summary.                                                                            |

## Configuration

| Variable                                 | Default                          | Purpose                                                                    |
| ---------------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `JARVIS_SERVER_URL`                      | `wss://localhost:54321/ws`       | `/ws` endpoint. Use `ws://` only on a trusted plain-HTTP dev server.       |
| `JARVIS_SATELLITE_TOKEN`                 | _(unset)_                        | Device token; overrides the credentials file.                              |
| `JARVIS_SATELLITE_INSECURE_TLS`          | `0`                              | Disable certificate verification for a local self-signed server.           |
| `JARVIS_SATELLITE_CA`                    | _(unset)_                        | PEM CA bundle for a private certificate.                                   |
| `JARVIS_SATELLITE_STATE_DIR`             | `~/.jarvis/satellite`            | Private state root.                                                        |
| `JARVIS_SATELLITE_MODEL_DIR`             | `<state>/models`                 | Whisper cache.                                                             |
| `JARVIS_SATELLITE_INPUT_DEVICE`          | _(system default)_               | SoX input name, e.g. `MacBook Pro Microphone` or `Anker PowerConf C200`.   |
| `JARVIS_SATELLITE_STT_MODEL`             | `onnx-community/whisper-tiny.en` | Transformers.js model id.                                                  |
| `JARVIS_SATELLITE_STT_DTYPE`             | `q8`                             | Model quantization.                                                        |
| `JARVIS_SATELLITE_SESSION_ID`            | _(persisted)_                    | Fixed voice thread id.                                                     |
| `JARVIS_SATELLITE_SESSION_FILE`          | `<state>/sessions.json`          | Thread id store.                                                           |
| `JARVIS_SATELLITE_ONSET_SECONDS`         | `0.3`                            | Speech needed before SoX starts recording.                                 |
| `JARVIS_SATELLITE_SILENCE_SECONDS`       | `0.9`                            | Trailing silence that ends an utterance.                                   |
| `JARVIS_SATELLITE_SILENCE_THRESHOLD`     | `1%`                             | SoX silence threshold.                                                     |
| `JARVIS_SATELLITE_MAX_UTTERANCE_SECONDS` | `12`                             | Hard cap on one utterance.                                                 |
| `JARVIS_SATELLITE_RECORD_TIMEOUT_MS`     | `20000`                          | Push-to-talk wait-for-speech cap.                                          |
| `JARVIS_SATELLITE_PTT_LEAD_MS`           | `600`                            | Delay after opening the mic before the “Speak now” cue (Bluetooth switch). |
| `JARVIS_SATELLITE_LOCAL_TTS`             | `0`                              | Speak with macOS `say`/Linux `espeak` when the server sends no audio.      |
| `JARVIS_SATELLITE_CONNECT_TIMEOUT_MS`    | `5000`                           | Connect timeout.                                                           |
| `JARVIS_SATELLITE_AUTH_TIMEOUT_MS`       | `5000`                           | Auth handshake timeout.                                                    |
| `JARVIS_CREDENTIALS_FILE`                | `~/.jarvis/credentials.json`     | Shared text-CLI credential store.                                          |
| `JARVIS_LOG_LEVEL`                       | `info`                           | `debug`, `info`, `warn`, `error`, `silent`.                                |

## Security notes

- Raw microphone audio never leaves the device; only the final transcript is
  sent.
- The device token is read from a `0600` file or the environment and is never
  printed. Use TLS (`wss://`) whenever the server is not on localhost.
- `JARVIS_SATELLITE_INSECURE_TLS=1` is a local-development escape hatch, not a
  deployment setting.
- The local transcript is printed to stdout as the satellite’s “you” line and
  is sent to the server as a normal chat prompt. It is not written to a log
  unless `JARVIS_LOG_SENSITIVE=full` is enabled.

## Not in this slice

- openWakeWord (the transcript-based wake path is the stand-in).
- Camera capture.
- Barge-in / interrupt while the reply is playing.
- Spoken timer/reminder notifications.
- Multi-satellite claim arbitration.
- A systemd/launchd installer (the README gives the runtime shape; service
  samples land with phase 1).

See [#240](https://github.com/LukeStanbery89/jarvis-v2/issues/240) for the
full roadmap.
