# Plan — #109 Split Chat.tsx (god component) into composable views and hooks

## Goal

Take `packages/web/src/views/Chat.tsx` (1,337 lines today) down to a <300-line
composition of dedicated components and hooks. No user-visible behavior change;
the split exists so the wiring stops being test-dead and effect-boundary bugs
stop hiding inside a 1,300-line monolith.

## Current anatomy (verified against source)

`Chat.tsx` today:

- Module scope: 7 helpers — `debugVoice`, `UPLOAD_BUDGET_BYTES`, `PendingImage`,
  `ThreadsAction`, `threadsReducer`, `SidebarRow`, `voiceStatusText` (all
  movable; `threadsReducer` is a thin reducer already built on the node-tested
  `threads.ts` helpers).
- Component state: `useReducer` ×1; `useState` ×**12** (`activeId`, `draft`, `rows`,
  `status`, `banner`, `streaming`, `pending`, `previews`, `locationOn`,
  `locationState`, `wakeOn`, `wakeServerReady`); `useRef` ×15 (half of them
  "create-once" instances: `stt`, `vad`, `wakeStt`, `wake`, `voice`, `audio`,
  `client`); `useCallback` ×6; `useSyncExternalStore` ×2 (voice snapshot, audio
  snapshot).
- `useEffect` ×**11** (the issue says 8; the count above is current): connect+refresh,
  voice dispose, audio dispose, wake probe, wake arm/disarm, barge-in watch,
  location, persist throttle, unmount flush, auto-scroll, composer focus.
- Handlers ×14 (function declarations in the body), ~350 lines of JSX composing
  four presentational regions: sidebar; status/banner + transcript; voice
  status/error lines; composer (incl. `PendingAttachments`).

Every piece of _behavior_ used by the component already lives in node-tested
modules (`threads.ts`, `ChatClient.ts`, `voice.ts`+`packages/voice`, `location.ts`,
`audio.ts`); the component layer concentrates the wiring. The web suite is
`environment: "node"`, includes only `src/**/*.test.ts` (`.tsx` never runs), so
moving behavior out of `.tsx` is exactly the repo's stated rule: "no behavior
may live only inside a component" (web README:121).

### Confirmed: two StrictMode latent bugs the split must fix

`main.tsx` wraps `<App/>` in `<StrictMode/>`. Under dev, React mounts, unmounts,
and remounts (effect → cleanup → effect). Two "shared render-built instance" bugs
follow from cleanup disposing a per-mount resource that the remount keeps using:

1. **The socket kill (issue's own blueprint).** The client is constructed during
   render (`clientRef.current === null && … new ChatClient(…)`, Chat.tsx:405-456);
   the mount effect calls `connect()` (Chat.tsx:473-475); cleanup calls
   `close()` (Chat.tsx:476-478). `close()` sets `closedByUser = true`
   permanently (ChatClient.ts:313) and `connect()` bails on it forever
   (ChatClient.ts:152-153). Under StrictMode the remount's `connect()` is a
   no-op — the socket never reconnects, dev `/web` sticks at `Disconnected`.
2. **The voice-controller kill (found by review).** The same sim-unmount
   disposes the **shared** `VoiceController` (`voice?.dispose()`, Chat.tsx:518-523).
   `dispose()` sets `disposed = true` permanently (controller.ts:480) and clears
   the engine listeners (:496); the instance is never reconstructed (ref
   persists). After one dev reload: wake arming, barge-in, and wake-session
   start are **permanently dead** — a silent voice regression the socket-focused
   check would never catch.

The fix, applied to both: **construct-in-effect** — each mount builds a fresh
instance and the cleanup closes/disposes exactly that instance, so StrictMode
plays `connect → close → fresh connect` (and `construct → dispose → fresh
construct`). Engines (`stt`/`vad`/`wakeStt`/`wake`) stay render-ref constructed:
they are cheap-to-recover providers (vosk recoverability: `types.ts:163`,
`vosk.ts:656-669`) and constructing them in an effect would flash the mic
button disabled for a frame. Prod (no StrictMode) behaves exactly as today.

## Design decisions

| Decision         | Choice                                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test strategy    | **Locked: node-pure-tests + explicit manual E2E script** (recommended)                                                                               | jsdom+RTL was considered (see below) and rejected: the monorepo has zero DOM-test deps (portal included); after the split the components are presentational (props-in/events-out), and behavior leaves `.tsx` into seam-injected `.ts` modules. A jsdom render test of `<Chat>` would need mocks for WebSocket, AudioContext, FileReader, geolocation, SpeechRecognition, IndexedDB, and the `?url` worker/wasm imports. Accepted in the issue: "or accept manual-test-only explicitly." |
| File layout      | Components → `src/views/chat/`; hooks → `src/hooks/` (new dir)                                                                                       | Keeps Chat-only pieces out of shared `src/components/` (`ToolCall` stays there).                                                                                                                                                                                                                                                                                                                                                                                                         |
| Hook granularity | 8 hooks, single-purpose; **Chat stays the composition root**                                                                                         | The issue's list (`useThreads`, `useChatClient`, `useVoiceSession`, `useLocationSharing`, `useAutoScroll`) plus `useSessions`, `useAudio`, `useAttachments`; cross-cutting orchestration (`runTurn`/`send`/`remove`/`onFrame`) stays in Chat so dataflow is explicit.                                                                                                                                                                                                                    |
| `activeIdRef`    | Owned by `useThreads`, returned to Chat                                                                                                              | The socket's `onFrame` reads a non-stale `activeId`; one owner alongside `activeId` state.                                                                                                                                                                                                                                                                                                                                                                                               |
| `runTurn` seam   | Chat owns `runTurn` (reads all hooks); `useVoiceSession.submit` is a stable wrapper over `runTurnRef.current`                                        | Mirrors today's `runTurnRef` (Chat.tsx:350-372) — the controller is constructed once; the seam must always read the latest closure.                                                                                                                                                                                                                                                                                                                                                      |
| `voice` access   | Chat closes over the **stable controller instance** directly from `useVoiceSession`; no `voiceRef` exposure                                          | The controller instance is stable for the view lifetime; `onFrame`/`onBargeIn` can close over it (they only run post-mount). Simple and reviewable.                                                                                                                                                                                                                                                                                                                                      |
| Attach cap gate  | `attachFiles` closes over `pending` from state exactly as today (Chat.tsx:714) — cap-check parity preserved, multi-drop edge keeps current semantics | No behavior change; documented deliberately rather than silently "fixed".                                                                                                                                                                                                                                                                                                                                                                                                                |

## Locked decisions

1. **Test strategy: node-pure-tests + manual E2E** (option a). No DOM-test deps.
   jsdom+RTL rejected on the grounds in the table above; a render smoke test can
   be revisited in a later issue if the component layer ever grows behavior.
2. **`attachments.ts` extraction: included.** The upload lifecycle leaves
   `useAttachments` and moves into a pure, dependency-injected module so the
   413-retry / preview-fallback / chip-transition logic becomes node-testable
   (details in Phase A).

Issues intentionally left open for later (not in scope):

- jsdom+RTL render tests and the `useChatClient` StrictMode-sequencing test they
  would enable.
- Portal (`packages/portal`) god components — separate follow-up.
- The `threads.ts` helpers (already node-tested; untouched).

## File layout

```
packages/web/src/
├── hooks/
│   ├── useThreads.ts          # reducer state + activeId + persistence effects (+ threadsReducer/ThreadsAction)
│   ├── useSessions.ts         # REST session rows; mount refresh + refreshSessions (401 → onAuthRejected)
│   ├── useAudio.ts            # AudioPlayer once-per-mount + speaking snapshot + dispose
│   ├── useChatClient.ts       # WS client constructed IN AN EFFECT (StrictMode fix) + latest-handler refs + injectable socketFactory/url
│   ├── useVoiceSession.ts     # engines (render-ref) + controller (construct-in-effect, StrictMode fix) + wake/barge-in/probe
│   ├── useLocationSharing.ts  # location pref state + geolocation effect + toggle
│   ├── useAttachments.ts      # thin wiring over attachments.ts: pending chips state, attach/detach/clear
│   └── useAutoScroll.ts       # scroll-to-bottom (used by Transcript)
├── attachments.ts             # PURE upload lifecycle: determineReady, retryOn413, previewFallback, chip transitions   [node-tested]
├── sidebar.ts                 # PURE: SidebarRow, mergeSessions(rows, threads), describeWakeState   [node-tested]
├── views/
│   ├── Chat.tsx               # <300-line composition root (runTurn/send/remove/onFrame/banner/status+voice lines)
│   └── chat/
│       ├── Sidebar.tsx
│       ├── Transcript.tsx     # memoized MessageRow; owns transcript div + useAutoScroll
│       ├── Composer.tsx       # owns draft + textarea ref (focus effect); paste/drop/file-input → onAttach
│       └── PendingAttachments.tsx
```

Pure helper moves: `ThreadsAction`+`threadsReducer` → `useThreads.ts`;
`SidebarRow` + the `entries` useMemo body → `sidebar.ts:mergeSessions` + `describeWakeState`;
`voiceStatusText` → `useVoiceSession.ts`; `PendingImage` + `UPLOAD_BUDGET_BYTES` +
`readAsDataUrl` + the upload lifecycle → `attachments.ts` (+ `readAsDataUrl`
re-exported by `useAttachments`); `debugVoice` + the `?url` vosk imports →
`useVoiceSession.ts`.

## Component contracts (props-in / events-out)

### Sidebar.tsx

```ts
export interface SidebarProps {
    username: string;
    entries: SidebarRow[]; // merged, newest-first
    activeId: string | null;
    streaming: boolean; // disables thread switching
    locationOn: boolean;
    locationState: LocationUiState; // pin style + note lines (note text stays in location.ts)
    wakeAvailable: boolean;
    wakeOn: boolean;
    wakeArmed: boolean; // from the voice snapshot
    onNewChat(): void;
    onOpenThread(id: string): void;
    onRemoveThread(id: string): void;
    onToggleLocation(): void;
    onToggleWake(): void;
    onSignOut(): void;
}
```

Uses `describeWakeState(wakeAvailable, wakeArmed)` (pure, from `sidebar.ts`) for
the wake button's aria-label/tooltip. All classnames/aria strings copied verbatim.

### Transcript.tsx

```ts
export interface TranscriptProps {
    messages: ThreadMessage[];
    previews: Record<string, string>; // attachmentId → data: URL
    hasThread: boolean; // false ⇒ "Pick a conversation…" hint
}
```

`<MessageRow message previews?>` memoized via `memo`, keyed by `message.id`.
Owns the `transcript` div ref and calls `useAutoScroll(ref, messages, activeId)`.
Renders the user-image previews / ToolCall / assistant (error or Markdown)
branches as today.

**The `status`, `banner`, and voice status/error lines stay in `Chat`'s JSX**
(the review's call): they are siblings of the `.transcript` div in
`<section className="conversation">` (connected/reconnecting/closed line,
`banner`, `voice-status`), not children of the transcript — passing them into
`Transcript` would blur its job.

### Composer.tsx

```ts
export interface ComposerProps {
    streaming: boolean; // gates everything; send↔stop button
    sttAvailable: boolean; // stt !== null ⇒ mic disabled + tooltip
    voiceState: VoiceSnapshot["state"];
    voiceTurnInFlight: boolean; // mic disabled while a voice turn is mid-flight
    pending: PendingImage[];
    onSend(text: string): void; // trimmed; Chat computes ready attachment ids + clears pending
    onStop(): void;
    onAttach(files: File[]): void;
    onRemoveChip(id: string): void;
    onMicPress(): void; // audio.unlock() + voice.press() folded into one Chat callback
}
```

Owns `draft` (`useState`), `composerRef` + focus-when-idle effect (moves out of
Chat), `fileInputRef` trigger for the 📎, paste/drop handlers, mic button,
send/stop toggle. On a send press: trims, guards (`"", streaming, no ready
text`), calls `setDraft("")` **synchronously** (the current order, Chat.tsx:918)
then `onSend(text)` — parity with today's clear-before-await.

### PendingAttachments.tsx

```ts
export interface PendingAttachmentsProps {
    pending: PendingImage[];
    onRemove(id: string): void;
}
```

The chips row (uploading/ready/failed text, preview `<img>`, remove ×).

## Hook contracts

### useThreads.ts

```ts
export function useThreads(
    username: string,
    storage: Storage = localStorage,
): {
    threads: ThreadMap;
    activeId: string | null;
    activeIdRef: RefObject<string | null>; // latest for socket closures
    openThread(id: string | null): void; // set OR clear activeId (remove() calls openThread(null))
    newChat(): void; // mints sessionId, ensure+activate
    persist(): void; // trailing write of latest map
    dispatch: Dispatch<ThreadsAction>;
};
```

Owns the reducer, throttled-persist effect (300 ms trailing), and unmount flush.
No `api`/token dependency. **`openThread` accepts `null`** so `remove()` can clear
an active thread without owning the state.

### useSessions.ts

```ts
export function useSessions(options: {
    token: string;
    userId: string;
    onAuthRejected(): void;
}): {
    rows: SessionSummary[];
    refreshSessions(): Promise<void>;
};
```

Owns `rows` **and a mount effect that calls `refreshSessions()` once**
(replacing Chat.tsx:473-475's co-located fetch; token/userId/onAuthRejected read
via latest refs, effect deps `[]`). Turn-end refreshes come from the returned
`refreshSessions`. 401 ⇒ `onAuthRejected`; other failures non-fatal (sidebar
keeps local threads).

### useAudio.ts

```ts
export function useAudio(options?: {
    createContext?: () => AudioContext | null;
}): {
    audio: AudioPlayer; // stable for view lifetime
    speaking: boolean; // useSyncExternalStore snapshot
    stop(): void;
    unlock(): void;
};
```

Once-per-mount render-ref player (downside-free: `AudioPlayer` tolerates
recreate, audio.ts:162-168) + dispose-on-unmount effect.

### useChatClient.ts (StrictMode fix + injectable seam)

```ts
export function useChatClient(options: {
    token: string;
    capabilities: ClientCapability[]; // type from @lukestanbery/jarvis-protocol, NOT readonly
    onAudio(pcm: Float32Array): void;
    onFrame(frame: ServerFrame): void;
    onAuthRejected(): void;
    url?: string; // default webSocketUrl()
    socketFactory?: WebSocketFactory; // default new WebSocket(url) — kept so the fix is testable
}): {
    client: ChatClient | null; // null before the first mount effect
    status: ChatStatus;
    isStreaming(): boolean;
    cancelTurn(): void;
    sendLocation(lat: number, lon: number): void;
};
```

- One `useEffect` **constructs** `new ChatClient(url, { … })`, stores it in a
  ref + `setClient(instance)`, calls `connect()`, and returns
  `close()` + null-out + `setClient(null)`. StrictMode: connect → close →
  fresh connect on separate instances.
- Event handlers install through **latest-prop refs** (`onAudioRef.current`,
  `onFrameRef.current`, `onAuthRejectedRef.current` updated every render), so
  the fixed instance always sees fresh callbacks.
- **Effect deps are `[]`** — `capabilities` is read once at construction, never a
  dep; Callers pass a module-level `CHAT_CAPABILITIES` const in Chat.tsx so the
  dep is avoided by construction.
- `url`/`socketFactory` stay injectable (defaulting to `webSocketUrl()` + the
  browser `WebSocket` — same as ChatClient.ts:159), preserving the seam the
  existing wire tests use and leaving a possible future
  StrictMode-sequencing test under a jsdom story (out of scope, decision #1).
- `client` as state lets render-time consumers branch on readiness; all call
  sites (`runTurn`, `cancelTurn`, `sendLocation`, `signOut`) are user-event-time.

### useVoiceSession.ts (StrictMode fix)

```ts
export function useVoiceSession(options: {
    engineAssets?: { workerUrl: string; wasmUrl: string }; // the ?url imports
    submit(text: string): Promise<void>; // stable wrapper over Chat's runTurnRef
    onWakeCue(): void; // latest-ref
    onBargeIn(): void; // latest-ref
}): {
    voice: VoiceController | null; // null until the mount effect runs (or no STT)
    snapshot: VoiceSnapshot;
    sttAvailable: boolean; // render-known from stt !== null — mic never flashes
    wakeAvailable: boolean;
    wakeOn: boolean;
    wakeArmed: boolean;
    wakeServerReady: boolean;
    voiceErrorText: string | null; // snapshot idle + error message
    voiceTurnInFlight: boolean;
    press(): void;
    toggleWake(): boolean; // persists the pref, RETURNS the new value (Chat unlocks audio only on enable)
};
```

- **Engines are render-ref** (`stt`/`vad`/`wakeStt`/`wake`, once per mount — the
  existing pattern, recoverable providers), so `sttAvailable` is true on frame
  one and the mic button never flashes.
- **The `VoiceController` is constructed in a mount `useEffect`**
  (`controllerRef.current = new VoiceController({ … })`, cleanup
  `dispose()` + null). Each StrictMode remount gets a fresh controller over the
  same engine instances — kill #2 fixed. `submit`/`onWakeCue`/`onBargeIn` are
  latest-props refs; `submit`'s default defers to `options.submit` (Chat's
  `runTurnRef` wrapper).
- The controller snapshot is served via `useSyncExternalStore` where
  `subscribe`/`getSnapshot` read `controllerRef.current` (falling back to
  `initialVoiceSnapshot` when null) — identical to today's `voice?.getSnapshot()
?? initialVoiceSnapshot` (Chat.tsx:483-495).
- Owns: wake probe effect (Chat.tsx:535-545), arm/disarm effect
  (Chat.tsx:549-559), barge-in watch effect gated on
  `snapshot.state === "speaking"` (Chat.tsx:567-576), dispose-on-unmount for the
  controller (the mount effect's cleanup), and the `voiceErrorText`/
  `voiceTurnInFlight` derivations.
- `toggleWake` persists the pref and **returns the new boolean**; Chat's wrapper
  calls `audio.unlock()` only when it came back `true` (preserving
  Chat.tsx:973-975).

### useLocationSharing.ts

```ts
export function useLocationSharing(options: {
    sendLocation(lat: number, lon: number): void; // latest-ref into the chat client
}): {
    locationOn: boolean;
    locationState: LocationUiState;
    toggleLocation(): void;
};
```

The pref state, the geolocation effect verbatim (off / unsupported / locating →
granted→send / denied / failed, cancelled flag), toggle + persist. The
`describeLocationState` text stays in `location.ts`.

### useAttachments.ts

```ts
export function useAttachments(options: {
    token: string;
    onError(message: string): void; // banner
}): {
    pending: PendingImage[];
    previews: Record<string, string>;
    attachFiles(files: FileList | File[]): void; // appends chips + runChipUpload; cap-check parity
    detachChip(id: string): void;
    clearPending(): void; // send + remove-active-thread
};
```

Thin wiring over the pure module (below): owns `pending`/`previews` state,
appends chips, and calls `runChipUpload` with the real io (the token from
options). `send` (in Chat) reads `determineReady(pending)`, calls
`clearPending()`, then runs the turn.

### attachments.ts (pure upload lifecycle — Phase A, locked)

The upload lifecycle — the 413-retry with `err.maxBytes`, the prepared-bytes
preview fallback, and the terminal `ready`/`failed` chip transitions — moves
here as a dependency-injected module (real I/O injected, so it is node-testable):

```ts
export const UPLOAD_BUDGET_BYTES = 4 * 1024 * 1024;

export interface PendingImage {
    id;
    name;
    dataUrl;
    state;
} // moved
export function capExceeded(pending: PendingImage[]): boolean; // >= MAX_ATTACHMENTS
export function determineReady(pending: PendingImage[]): string[]; // ready ids, order
export function isRetryableLimit(err: unknown): err is UploadLimitError;

export interface UploadIo {
    readDataUrl(file: File): Promise<string>;
    prepare(
        file: File,
        budgetBytes: number,
    ): Promise<{ mime: string; base64: string }>;
    upload(token: string, base64: string): Promise<{ attachmentId: string }>;
}
export function runChipUpload(
    io: UploadIo,
    token: string,
    chip: PendingImage,
    file: File,
    budgetBytes?: number,
): Promise<{
    chip: PendingImage;
    preview?: { attachmentId: string; dataUrl: string };
}>;

export async function readAsDataUrl(file: File): Promise<string>; // moved
```

`MAX_ATTACHMENTS` (protocol) drives `capExceeded`; `UPLOAD_BUDGET_BYTES` lives
here. Phase A wires the real io once in `Chat.tsx`
(`readDataUrl`, `prepareForUpload`, `api.uploadAttachment`); Phase B moves that
wiring into `useAttachments`, whose chips state sits on top of `runChipUpload`.

_(Implementation note: the sketch originally proposed a `prepareUploadPolicy(io)`
factory plus an unused `delay` seam; the shipped shape is the flat
`runChipUpload` above — same behavior, smaller surface. The one observable
difference is cosmetic: the chip's `dataUrl` is filled once at completion
instead of mid-flight, and the chip shows `uploading <name>…` throughout either
way.)_

### useAutoScroll.ts

```ts
export function useAutoScroll(
    containerRef: React.RefObject<HTMLDivElement | null>,
    messages: ThreadMessage[],
    activeId: string | null,
): void; // effect deps [messages, activeId] — the exact fidelity of Chat.tsx:681-686
```

## Chat.tsx composition (target ≈ 210 lines)

Composition order matters (no circular seams): state hooks first, then
`useVoiceSession`, then `useChatClient` (whose `onFrame` closes over `voice`),
then the Chat-owned handlers.

```tsx
const CHAT_CAPABILITIES: ClientCapability[] = [
    "markdown",
    "image",
    "link",
    "audio",
];

export function Chat({ credential, onAuthRejected, onSignedOut }: ChatProps) {
    const {
        threads,
        activeId,
        activeIdRef,
        openThread,
        newChat,
        persist,
        dispatch,
    } = useThreads(credential.username);
    const { rows, refreshSessions } = useSessions({
        token: credential.token,
        userId: credential.userId,
        onAuthRejected,
    });
    const {
        audio,
        speaking,
        stop: stopAudio,
        unlock: unlockAudio,
    } = useAudio();
    const [banner, setBanner] = useState<string | null>(null);
    const [streaming, setStreaming] = useState(false);
    const { pending, previews, attachFiles, detachChip, clearPending } =
        useAttachments({ token: credential.token, onError: setBanner });
    const runTurnRef = useRef<RunTurn | null>(null);

    const voiceUi = useVoiceSession({
        engineAssets: { workerUrl: voskWorkerUrl, wasmUrl: voskWasmUrl },
        submit: (text) => runTurnRef.current?.(text, "voice", []),
        onWakeCue: () => audio.blip(),
        onBargeIn: () => {
            stopAudio();
            client?.cancelTurn();
        }, // client from below (post-mount)
    });
    const { voice } = voiceUi;

    const { client, status, isStreaming, cancelTurn, sendLocation } =
        useChatClient({
            token: credential.token,
            capabilities: CHAT_CAPABILITIES,
            onAudio: (pcm) => audio.play(pcm),
            onFrame: (frame) => {
                // stable per-render; hook latest-refs it
                voice?.noteResponseFrame();
                if ("audioStart" in frame) {
                    audio.setFormat(frame.audioStart.sampleRate);
                    voice?.noteAudioStarted();
                }
                const sessionId = activeIdRef.current;
                if (sessionId === null) return;
                if ("chunk" in frame)
                    dispatch({
                        type: "chunk",
                        sessionId,
                        text: frame.chunk,
                        at: Date.now(),
                    });
                else if ("tool" in frame)
                    dispatch({
                        type: "tool",
                        sessionId,
                        name: frame.tool.name,
                        args: frame.tool.args,
                        at: Date.now(),
                    });
                else if ("toolResult" in frame)
                    dispatch({
                        type: "toolResult",
                        sessionId,
                        name: frame.toolResult.name,
                        output: frame.toolResult.output,
                        at: Date.now(),
                    });
            },
            onAuthRejected,
        });
    const { locationOn, locationState, toggleLocation } = useLocationSharing({
        sendLocation,
    });

    const entries = useMemo(
        () => mergeSessions(rows, threads),
        [rows, threads],
    );
    const activeThread = activeId !== null ? (threads[activeId] ?? null) : null;

    const runTurn = useCallback(
        async (text, mode, attachmentIds) => {
            const sessionId = activeIdRef.current;
            if (sessionId === null) throw new Error("no conversation is open");
            if (isStreaming())
                throw new Error("another prompt is already in progress");
            dispatch({
                type: "user",
                sessionId,
                text,
                at: Date.now(),
                ...(attachmentIds.length ? { attachmentIds } : {}),
            });
            setStreaming(true);
            try {
                await client?.prompt(text, sessionId, attachmentIds, mode);
            } finally {
                setStreaming(false);
                persist();
                void refreshSessions();
            }
        },
        [
            activeIdRef,
            isStreaming,
            dispatch,
            setStreaming,
            persist,
            refreshSessions,
        ],
    );
    runTurnRef.current = runTurn;

    const send = (text: string): void => {
        void (async () => {
            clearPending();
            try {
                await runTurn(text, "text", readyAttachmentIds());
            } catch (err) {
                dispatch({
                    type: "assistantError",
                    sessionId: activeId!,
                    text:
                        err instanceof Error
                            ? err.message
                            : "the request failed",
                    at: Date.now(),
                });
            }
        })();
    };
    const remove = async (id: string): Promise<void> => {
        /* api.deleteSession + 404-swallow + dispatch deleted + openThread(null) if activeId matches + clearPending() + refreshSessions() */
    };
    const stopTurn = (): void => {
        stopAudio();
        cancelTurn();
    };
    const signOut = (): void => {
        client?.close();
        onSignedOut();
    };
    const toggleWake = (): void => {
        if (voiceUi.toggleWake()) unlockAudio();
    };
    const voiceStatus =
        voiceUi.snapshot.state === "speaking" || speaking
            ? "Speaking…"
            : voiceStatusText(voiceUi.snapshot);

    return (
        <main className="chat">
            <Sidebar
                username={credential.username}
                entries={entries}
                activeId={activeId}
                streaming={streaming}
                locationOn={locationOn}
                locationState={locationState}
                wakeAvailable={voiceUi.wakeAvailable}
                wakeOn={voiceUi.wakeOn}
                wakeArmed={voiceUi.wakeArmed}
                onNewChat={newChat}
                onOpenThread={openThread}
                onRemoveThread={(id) => void remove(id)}
                onToggleLocation={toggleLocation}
                onToggleWake={toggleWake}
                onSignOut={signOut}
            />
            <section className="conversation">
                {status !== "connected" && (
                    <p className="status" role="status">
                        …
                    </p>
                )}
                {banner && (
                    <p className="status error" role="alert">
                        {banner}
                    </p>
                )}
                <Transcript
                    messages={activeThread?.messages ?? []}
                    previews={previews}
                    hasThread={activeThread !== null}
                />
                {voiceStatus !== null && (
                    <p className="voice-status" role="status">
                        {voiceStatus}
                    </p>
                )}
                {voiceUi.voiceErrorText !== null && (
                    <p className="voice-status error" role="alert">
                        {voiceUi.voiceErrorText}
                    </p>
                )}
                {activeId !== null && (
                    <Composer
                        streaming={streaming}
                        sttAvailable={voiceUi.sttAvailable}
                        voiceState={voiceUi.snapshot.state}
                        voiceTurnInFlight={voiceUi.voiceTurnInFlight}
                        pending={pending}
                        onSend={send}
                        onStop={stopTurn}
                        onAttach={attachFiles}
                        onRemoveChip={detachChip}
                        onMicPress={() => {
                            unlockAudio();
                            voice?.press();
                        }}
                    />
                )}
            </section>
        </main>
    );
}
```

`runTurn` is assigned post-definition (`runTurnRef.current = runTurn`,
Chat.tsx:903) so the voice `submit` seam and the prompt path share one
implementation. `send` catches for the text path; voice submits reject into the
controller's `rejected` state as today.

## No-behavior-change invariants (checked at review + in the PR)

- All classnames, aria-labels, title strings byte-identical (grep-audit the diff
  for `.status`, `.msg`, `.composer`, `.mic`, `.send`, `.new-chat`, …).
- Banner / placeholder / status / hint strings byte-identical.
- localStorage keys untouched: `jarvis.web.user.<name>.threads`, credential leaf,
  `jarvis.wake.enabled`, location pref leaf.
- Persistence cadence unchanged: 300 ms trailing throttle, turn-end `persist()`,
  unmount flush; quota-eviction order untouched.
- Wire behavior untouched: hello/auth order + capabilities list, location
  re-announce on reconnect, cancel semantics + dropped-generation filter.
- `NEW_CHAT_TITLE`/200-cap/4 MiB budget constants identical.
- **`MAX_ATTACHMENTS` cap-check parity is deliberate** (attach closes over `pending`
  state exactly as today, multi-file edge keeps current semantics) — documented,
  not silently "fixed".
- StrictMode dev changes only: the socket and voice controller now survive a
  simulated unmount (previously: stuck `Disconnected` + dead wake/barge-in);
  prod DOM output unchanged.

## Sequencing (each phase ends `npm run check` green)

1. **Phase A — pure extraction (+ tests). ✅ done.** Moved
   `threadsReducer`/`ThreadsAction` → `src/hooks/useThreads.ts`, `SidebarRow` +
   `mergeSessions` + `describeWakeState` → `src/sidebar.ts`, `voiceStatusText` →
   `src/hooks/useVoiceSession.ts`, `PendingImage` + budget + `readAsDataUrl` +
   the upload lifecycle → `src/attachments.ts`; Chat imports them. The shipped
   attachments API is `determineReady` / `capExceeded` / `isRetryableLimit` /
   `runChipUpload(io, …)` with injected `readDataUrl`/`prepare`/`upload` (see
   the attachments.ts section for the deviation note). Tests:
   `src/sidebar.test.ts` (server-only/local-only/id-merge/max-timestamp/
   newest-first/`Thread <id>` fallback/voice kind; `describeWakeState`),
   `src/attachments.test.ts` (413-retry at half the cap, read-failure +
   empty-read preview fallback, non-413 + double-413 failure notes,
   `determineReady` ordering, `capExceeded`, `isRetryableLimit`) with a fake
   `UploadIo`, `src/hooks/useThreads.test.ts` (reducer transitions incl.
   attachment ids + toolResult merge), and `src/hooks/useVoiceSession.test.ts`
   (`voiceStatusText` mapping). `npm run check` green.
2. **Phase B — hooks.** Extract the eight hooks; Chat consumes them. The two
   StrictMode fixes land here (construct-in-effect `useChatClient` +
   `useVoiceSession` controller). No JSX movement yet. Commit after green + dev
   smoke covering **socket AND wake/barge-in** (see E2E).
3. **Phase C — components.** Extract Sidebar/Transcript/Composer/PendingAttachments;
   Chat becomes the ~210-line composition. Commit.
4. **Phase D — docs + manual script + PR.** Update the web README — `Chat.tsx`
   references at `:81`, `:168`, and the `Source layout` row at `:256`, plus the
   voice-wiring paragraph (:162-172) — and root AGENTS if the file map changes;
   JSDoc on every new/modified function (root AGENTS rule); record the manual
   E2E script in the PR; `npm run check` + `npm run build`; PR closes `#109`.

## Manual E2E script (recorded in the PR, per acceptance)

Run the server (`npm run dev`, :54321) and the web client (Vite dev, /web).
Sign in → auto-auth on reload. New chat → typed turn → streamed markdown renders.
Stop button mid-turn; thread switching disabled while streaming. Voice press →
listening partial → submit → voice turn in history; a mic-denied/failed session
stays as an alert until the next press. Barge-in over a playing reply (stops
playback, cancels, seeds the interruption). Wake toggle arms/arms-off and a wake
turn submits (needs `JARVIS_WAKE_PROVIDER=openwakeword` + TTS). Location pin
states (unsupported on plain HTTP / denied / active) + persisted opt-out.
Attachments: 📎 / paste / drag-drop; chips upload→ready; send with image;
analysis renders; reload shows the muted "image not retained" note; 5-image
banner + cap parity; chip remove. Delete an active and an inactive thread
(composer cleared + server row gone). **StrictMode dev check (extended):
hard-reload /web — the socket must stay connected AND the wake toggle + barge-in
must still work after the first simulated unmount** (the pre-split build failed
both).

## Risks

- **Stale closures after the split.** Mitigated by owner-in-hook refs
  (`activeIdRef`, latest-prop refs in `useChatClient`/`useVoiceSession`) and the
  E2E barge-in + wake checks that exercise the seams across renders.
- **Persist-cadence drift**: turn-end `persist()` lives in Chat, the throttle +
  unmount flush in `useThreads`; the flush reads the latest map via the hook's
  internal ref — preserved.
- **Controller-null window**: `voice`/`client` are `null` for one frame
  post-mount; all consumers are event-time (no render-time deref), and
  `sttAvailable` stays driven by the render-ref engine so the mic never flashes.
- **Component props drift**: explicit contracts above + the no-behavior-change
  audit.

## Out of scope

- jsdom+RTL render tests and the `useChatClient` StrictMode-sequencing test they
  would enable (locked decision #1; the `socketFactory` seam is kept so they
  remain possible later).
- Portal (`packages/portal`) god components — separate follow-up.
- The `threads.ts` helpers (already node-tested; untouched).
- Portal (`packages/portal`) god components — separate follow-up.
- The `threads.ts` helpers (already node-tested; untouched).

## Review log (adversarial pass, findings → resolution)

| Find (review)                                                                                                                               | Resolution in this plan                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| StrictMode voice-controller kill (`dispose()` sets `disposed` permanently; shared instance never reconstructed → wake/barge-in dead in dev) | Construct-in-effect for the controller (S1 fixed); engines stay render-ref; E2E extended to cover wake + barge-in under StrictMode                                   |
| `remove()` can't clear `activeId` under the `useThreads` contract                                                                           | `openThread(id: string \| null)`; `remove` calls `openThread(null)`                                                                                                  |
| Initial `GET /api/sessions` fetch homeless                                                                                                  | `useSessions` gets a mount-refresh effect (replaces Chat.tsx:473-475)                                                                                                |
| `voiceStatus` "Speaking…" needs the audio snapshot                                                                                          | Chat composes `voiceStatus` from `speaking` + snapshot; hook returns `voiceErrorText`/`voiceTurnInFlight` only                                                       |
| Hook ordering/seams circular (`onFrame` needs voice; `onBargeIn` needs client)                                                              | Compose `useVoiceSession` before `useChatClient`; `onBargeIn` closes over `audio.stop()` + `client` (post-mount); `runTurnRef` submit seam; event props latest-ref'd |
| `draft` reset + ready-id duplication ambiguous                                                                                              | Composer clears its own draft synchronously; `onSend(text)`; Chat computes ready ids + `clearPending()`                                                              |
| `toggleWake` unlock-on-disable risk                                                                                                         | Hook `toggleWake(): boolean`; Chat unlocks only when it returned `true`                                                                                              |
| `useAutoScroll` wrong signature (needs two deps)                                                                                            | `(ref, messages, activeId)`, deps `[messages, activeId]`                                                                                                             |
| `MAX_ATTACHMENTS` gate parity                                                                                                               | Deliberately preserved (closure over `pending`), documented                                                                                                          |
| inline `capabilities` array would reconnect every render                                                                                    | Module `CHAT_CAPABILITIES` const + effect-deps `[]`                                                                                                                  |
| `socketFactory`/url seam dropped from the fix                                                                                               | Re-added as injectable defaults (parity + future test)                                                                                                               |
| Status/banner/voice lines: Transcript vs Chat                                                                                               | Kept in Chat's JSX (siblings of `.transcript`, not children)                                                                                                         |
| `capabilities: readonly string[]` won't typecheck                                                                                           | `ClientCapability[]` from the protocol package                                                                                                                       |
| Anatomy counts + README line refs wrong (12 useState; 7 helpers; README 81/168/256)                                                         | Corrected above                                                                                                                                                      |
| `describeWakeState` had two homes (contradiction)                                                                                           | Pure fn in `sidebar.ts`, used by Sidebar only                                                                                                                        |
| JSDoc + README updates missing from the plan                                                                                                | Added to Phase D + conventions line                                                                                                                                  |
