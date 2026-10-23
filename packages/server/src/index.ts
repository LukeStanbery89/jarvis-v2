/**
 * Server entry point.
 *
 * Builds the Express app, opens the app database (users/devices/sessions) and
 * the notification surface built on it, boots the agent graph (creating
 * `~/.jarvis` and the checkpoint store) with that surface's tool injected,
 * hands the app to the listener seam, and attaches the WebSocket chat server.
 *
 * Transport selection, TLS, the cert reads, and the HTTPS redirect listener
 * all live in `src/listener.ts`; this file is a thin composition root.
 */
// Must stay the first import: dotenv loads `.env` into `process.env` before
// `config.ts` reads it. Real environment variables always win over the file.
import "dotenv/config";
import path from "node:path";
import { createApp } from "./app";
import {
    getAppConfig,
    getLlmConfig,
    getServerPort,
    DEFAULT_HOST,
    DEFAULT_ATTACHMENT_CONFIG,
} from "./config";
import { attachChatServer } from "./ws";
import { initAgentGraph, getAgentTools } from "./agent";
import { createVisionModel } from "./llm/visionModel";
import { createTavilyClient } from "./llm/tools/search/tavily";
import { createSerperClient } from "./llm/tools/search/serper";
import { createOpenWeatherClient } from "./llm/tools/weather/openweather";
import { createHomeAssistantClient } from "./llm/tools/homeAssistant/client";
import { createWikipediaClient } from "./llm/tools/wikipedia/client";
import {
    createAttachmentStore,
    sweepOrphanAttachments,
} from "./attachments/store";
import { InFlightLimiter, VlCallLimiter } from "./attachments/limiters";
import { FixedWindowQuota } from "./rate/fixedWindowQuota";
import { KokoroTtsProvider } from "./tts/kokoro";
import { createNotificationHub } from "./notify/hub";
import { createInAppChannel } from "./notify/channels/inApp";
import { createNotificationService } from "./notify/service";
import { createJobCreator } from "./scheduler/create";
import { createJobRunner } from "./scheduler/runner";
import { createScheduler } from "./scheduler/loop";
import { createCodingJobService } from "./sandbox/service";
import { startCodingWatch } from "./sandbox/watch";
import {
    createSandboxProxy,
    loadProxySecret,
    verifyJobToken,
    type SandboxProxy,
} from "./sandbox/proxy";
import { createGitHubClient } from "./github/client";
import { createDockerSandbox } from "./sandbox/docker";
import { createGitHubPublisher } from "./sandbox/publish";
import { createWorkspaceManager } from "./sandbox/workspace";
import { openAppDatabase } from "@lukestanbery/jarvis-auth";
import { createJarvisServer } from "./listener";
import { logger } from "./logger";

const port = getServerPort();
const appConfig = getAppConfig();
const host = appConfig.host ?? DEFAULT_HOST;

const attachmentConfig = appConfig.attachments ?? DEFAULT_ATTACHMENT_CONFIG;
// Clear last process's orphans before anything can upload; the mtime filter
// keeps this race-free against a request that lands while it runs.
void sweepOrphanAttachments(attachmentConfig);
const attachments = createAttachmentStore(attachmentConfig);
const inFlight = new InFlightLimiter(attachmentConfig.maxInflight);
const vlLimiter = new VlCallLimiter(attachmentConfig.vlCallsPerMin);

// Web search (#9): present only when at least one provider key is
// configured; providers stay in priority order (Tavily's free quota first).
const searchProviders = appConfig.search
    ? [
          ...(appConfig.search.tavilyApiKey
              ? [
                    createTavilyClient({
                        apiKey: appConfig.search.tavilyApiKey,
                        maxResults: appConfig.search.maxResults,
                        timeoutMs: appConfig.search.timeoutMs,
                    }),
                ]
              : []),
          ...(appConfig.search.serperApiKey
              ? [
                    createSerperClient({
                        apiKey: appConfig.search.serperApiKey,
                        maxResults: appConfig.search.maxResults,
                        timeoutMs: appConfig.search.timeoutMs,
                    }),
                ]
              : []),
      ]
    : [];
const searchDeps =
    searchProviders.length > 0
        ? {
              providers: searchProviders,
              quota: new FixedWindowQuota(appConfig.search!.callsPerMin),
          }
        : undefined;
logger.info(
    searchProviders.length > 0
        ? `Web search active: ${searchProviders.map((p) => p.name).join(" + ")}`
        : "Web search disabled (no provider API keys configured)",
);

// Weather (#31): present only when the OpenWeather key is configured — no
// key, no getWeather tool.
const weatherDeps = appConfig.weather
    ? {
          provider: createOpenWeatherClient({
              apiKey: appConfig.weather.apiKey,
              units: appConfig.weather.units,
              timeoutMs: appConfig.weather.timeoutMs,
          }),
          quota: new FixedWindowQuota(appConfig.weather.callsPerMin),
          units: appConfig.weather.units,
      }
    : undefined;
logger.info(
    weatherDeps
        ? `Weather active: openweather (${weatherDeps.units})`
        : "Weather disabled (no OPENWEATHER_API_KEY configured)",
);

// Home Assistant (#15): present only when the URL and access token are both
// configured — no credentials, no homeAssistant tool.
const homeAssistantDeps = appConfig.homeAssistant
    ? {
          provider: createHomeAssistantClient({
              url: appConfig.homeAssistant.url,
              accessToken: appConfig.homeAssistant.accessToken,
              readDomains: appConfig.homeAssistant.readDomains,
              timeoutMs: appConfig.homeAssistant.timeoutMs,
              cacheTtlMs: appConfig.homeAssistant.cacheTtlMs,
          }),
          quota: new FixedWindowQuota(appConfig.homeAssistant.callsPerMin),
          controlDomains: appConfig.homeAssistant.controlDomains,
          listLimit: appConfig.homeAssistant.listLimit,
          lightTokens: appConfig.homeAssistant.lightTokens,
      }
    : undefined;
logger.info(
    homeAssistantDeps
        ? `Home Assistant active: ${appConfig.homeAssistant?.url} (read: ${appConfig.homeAssistant?.readDomains.join(", ")}; control: ${appConfig.homeAssistant?.controlDomains.join(", ")}; lights by ${appConfig.homeAssistant?.lightTokens.join(",")})`
        : "Home Assistant disabled (no HOME_ASSISTANT_URL or HOME_ASSISTANT_ACCESS_TOKEN configured)",
);

// Wikipedia (#8): no credential to gate on, so this is ON unless explicitly
// switched off — `JARVIS_WIKIPEDIA=off` leaves `appConfig.wikipedia`
// undefined. Two guest budgets are built alongside the per-user one and all
// three live for the process (see the rate-limiting section of README.md):
// the per-session bucket bounds one conversation, and the per-address bucket
// bounds a guest who opens a fresh socket for a fresh session.
const wikipediaDeps = appConfig.wikipedia
    ? {
          provider: createWikipediaClient({
              lang: appConfig.wikipedia.lang,
              timeoutMs: appConfig.wikipedia.timeoutMs,
              userAgent: appConfig.wikipedia.userAgent,
              maxSentences: appConfig.wikipedia.maxSentences,
              maxFullChars: appConfig.wikipedia.maxFullChars,
              maxCandidates: appConfig.wikipedia.maxCandidates,
          }),
          quota: new FixedWindowQuota(appConfig.wikipedia.callsPerMin),
          guest: {
              session: new FixedWindowQuota<string>(
                  appConfig.wikipedia.guestSessionPerMin,
              ),
              address: new FixedWindowQuota<string>(
                  appConfig.wikipedia.guestIpPerMin,
              ),
          },
      }
    : undefined;
logger.info(
    wikipediaDeps
        ? `Wikipedia active: ${appConfig.wikipedia?.lang}.wikipedia.org (users ${appConfig.wikipedia?.callsPerMin}/min; guests ${appConfig.wikipedia?.guestSessionPerMin}/session/min and ${appConfig.wikipedia?.guestIpPerMin}/address/min)`
        : "Wikipedia disabled (JARVIS_WIKIPEDIA=off)",
);

// Server-side TTS (#83): present only when a provider is configured — unset
// JARVIS_TTS_PROVIDER means sockets never see audio frames. Constructing the
// provider is always safe: the engine module loads lazily on first synthesis,
// so a missing optional dependency fails (quietly, per turn) only when TTS is
// both configured and used.
const tts = appConfig.tts
    ? new KokoroTtsProvider({
          voice: appConfig.tts.voice,
          speed: appConfig.tts.speed,
      })
    : undefined;
logger.info(
    tts
        ? `TTS active: ${appConfig.tts?.provider} (voice: ${appConfig.tts?.voice})`
        : "TTS disabled (JARVIS_TTS_PROVIDER unset)",
);

// Local STT model serving (#84 P3b): present only when configured — unset
// JARVIS_STT_PROVIDER means GET /api/stt/model answers 404 and clients fall
// back to their other engines. The archive downloads lazily on the first
// client request, never at boot.
logger.info(
    appConfig.stt
        ? `STT model serving active: ${appConfig.stt.modelUrl} → ${appConfig.stt.modelDir}`
        : "STT model serving disabled (JARVIS_STT_PROVIDER unset)",
);

// Local wake-word model serving (#84 P4): present only when configured —
// unset JARVIS_WAKE_PROVIDER means GET /api/wake/model/:file answers 404
// and the client's wake toggle stays off. The three ONNX files download
// lazily on the first client request, never at boot.
logger.info(
    appConfig.wake
        ? `Wake model serving active: ${appConfig.wake.baseUrl} → ${appConfig.wake.modelDir}`
        : "Wake model serving disabled (JARVIS_WAKE_PROVIDER unset)",
);

const store = openAppDatabase(appConfig.appDbPath, {
    /**
     * A migration repaired something on the way in (#90 phase 6c).
     *
     * At `warn`, and it names the counts: a silent repair of real data is the
     * kind of thing that is only ever learned the hard way, and the repair is
     * evidence that something wrote to this database without foreign keys
     * enforced (the `sqlite3` CLI leaves them off by default).
     */
    onMigrationRepair: (report) => {
        logger.warn(
            `App database repaired during migration: ${report.repairedNotificationJobLinks} notification job link(s) nulled, ${report.droppedOrphanedNotifications} orphaned notification row(s) dropped`,
        );
    },
});

// Say *which* database this process opened, before anything else can be
// mistaken for "the database". The checkpoint path is logged when the graph
// comes up; without this line, a job inserted into the file a hand-written
// `sqlite3` command happened to point at looks exactly like a scheduler that
// never fires (it happened, on 2026-10-17).
logger.info(`App database: ${appConfig.appDbPath}`);

// Notifications (#139): the connection registry is built here and handed to
// the REST surface (which needs it to know whether the user is reachable), the
// chat server (which fills it in as sockets authenticate), and the agent (the
// `sendNotification` tool, one of the registry's consumers below). Absent when
// `JARVIS_NOTIFY=off`, which unmounts the routes, the delivery wiring, and the
// tool together — a half-wired surface would record notifications nobody can
// be told about.
const notifyConfig = appConfig.notify;
const notificationHub = notifyConfig ? createNotificationHub() : null;
const notifications =
    notifyConfig && notificationHub
        ? createNotificationService({
              store,
              hub: notificationHub,
              channels: [createInAppChannel(notificationHub)],
              maxPerUser: notifyConfig.maxPerUser,
              deliveriesPerWindow: notifyConfig.deliveriesPerMin,
          })
        : undefined;

// The coding sandbox (#141): present only when a container runtime is
// configured, because the surface must not promise work it cannot run. Built
// before the graph so the `startCodingJob` tool can be handed the supervisor;
// recovery runs below, once the socket layer is up, so an adopted job's
// announcement has a hub to land in.
//
// The broker (#141 phase 7) lives here too: it holds the provider key and each
// job talks to it with a token derived from its own id, so nothing in a
// container's environment is a credential that outlives the job.
let sandboxProxy: SandboxProxy | undefined;
let proxySecret: string | undefined;
let codingJobs: ReturnType<typeof createCodingJobService> | undefined;
// One GitHub client serves publishing, follow-ups and the tracker tools
// (#140). It is created when the App is configured even without the sandbox:
// reading an issue or commenting on it needs no container.
const githubClient = appConfig.github
    ? createGitHubClient(appConfig.github)
    : undefined;
if (appConfig.sandbox) {
    const sandbox = appConfig.sandbox;
    proxySecret = loadProxySecret(
        sandbox.proxySecret,
        path.join(path.dirname(appConfig.appDbPath), "sandbox-proxy.key"),
    );
    // In sidecar mode the broker runs in its own container on the job's
    // internal network, and this process must not listen for jobs at all.
    if (sandbox.proxyMode === "embedded") {
        // The compatibility path is not the #141 posture: on the bridge a job
        // reaches whatever the host can. Say so once, at boot, rather than
        // letting the deployment look identical to a sidecar one.
        logger.warn(
            "coding sandbox: embedded broker mode — jobs use the Docker bridge and can reach the internet directly; set JARVIS_SANDBOX_PROXY_MODE=sidecar for the #141 egress posture",
        );
        sandboxProxy = createSandboxProxy({
            bind: sandbox.proxyBind,
            port: sandbox.proxyPort,
            url: sandbox.proxyUrl,
            secret: proxySecret,
            upstreamBaseUrl: sandbox.llmBaseUrl,
            model: sandbox.model,
            apiKey: sandbox.apiKey,
            maxRequestsPerJob: sandbox.proxyMaxRequestsPerJob,
            // Per request, not once: a settle, cancel or prune revokes the token
            // immediately, even one that leaked out of the container.
            isJobActive: (jobId) => {
                const job = store.getCodingJobById(jobId);
                return (
                    job !== null &&
                    (job.state === "queued" || job.state === "running")
                );
            },
        });
    } else if (sandbox.network.trim().length === 0) {
        // The service refuses each job, but a boot line is visible before the
        // first request and names the setting to fix.
        logger.warn(
            "coding sandbox: sidecar mode has no JARVIS_SANDBOX_NETWORK; every job will be refused until an internal network is set",
        );
    }
    // The listener starts at the bottom of this file, chained ahead of coding
    // recovery: every job now depends on it, and an adopted container's first
    // model call must find it open. A broker that cannot bind is a sandbox that
    // cannot run, and exiting is better than a silent "the model refused" on
    // every job. A sidecar has no local listener, so recovery waits for
    // nothing there.
    const workspace = createWorkspaceManager({
        root: sandbox.workspaceRoot,
        hostRoot: sandbox.workspaceHostRoot,
        repos: sandbox.repos,
    });
    // Publishing is optional and separate from running the job: without a
    // GitHub App the branch stays local and the workspace is kept (#140). The
    // shared client means the installation token is exchanged once and cached
    // across publishing, follow-ups and the tracker tools.
    const publisher = githubClient
        ? createGitHubPublisher({
              client: githubClient,
              push: (input) => workspace.push(input),
              ...(appConfig.github?.reviewer
                  ? { reviewer: appConfig.github.reviewer }
                  : {}),
          })
        : undefined;
    codingJobs = createCodingJobService({
        ledger: store,
        runner: createDockerSandbox({
            socketPath: sandbox.socketPath,
        }),
        workspace,
        config: sandbox,
        proxy: { url: sandbox.proxyUrl, secret: proxySecret },
        ...(publisher ? { publisher } : {}),
        ...(githubClient
            ? {
                  pullRequests: (input) =>
                      githubClient.readPullRequest(
                          input.owner,
                          input.repo,
                          input.number,
                      ),
                  issues: (input) =>
                      githubClient.getIssue(
                          input.owner,
                          input.repo,
                          input.number,
                      ),
                  // The agent has no GitHub credential; the supervisor posts
                  // the plan/questions with the App token (#94).
                  commentOnIssue: (input) =>
                      githubClient
                          .commentOnIssue(
                              input.owner,
                              input.repo,
                              input.number,
                              input.body,
                          )
                          .then((comment) => ({
                              id: comment.number,
                              url: comment.url,
                          })),
              }
            : {}),
        ...(notifications ? { notifications } : {}),
    });
    // The SDLC re-arm loop (#94): answers on an issue, and new review
    // feedback on a JARVIS PR, become follow-up runs. It needs the App (to
    // read the threads and know its own login) and can be turned off.
    if (githubClient && sandbox.watchEnabled) {
        startCodingWatch({
            ledger: store,
            github: githubClient,
            service: codingJobs,
            intervalMs: sandbox.watchIntervalMs,
        });
        logger.info(
            `Coding watch active: every ${Math.round(
                sandbox.watchIntervalMs / 1000,
            )}s`,
        );
    }
}

// Say so at boot. The tool's absence is silent otherwise, and "the model
// refused to touch code" is exactly what a missing registration looks like
// from the outside — the distinction cost a debugging session once.
if (appConfig.sandbox && codingJobs) {
    logger.info(
        `Coding sandbox active: image=${appConfig.sandbox.image}, repos=${
            appConfig.sandbox.repos.join(",") || "(none)"
        }, model=${appConfig.sandbox.model || "(unset)"}, mode=${
            appConfig.sandbox.proxyMode
        }, network=${
            appConfig.sandbox.network || "(bridge)"
        }, proxy=${appConfig.sandbox.proxyUrl}, apiKey=${
            appConfig.sandbox.apiKey.length > 0 ? "set" : "unset"
        } (held by the broker), github=${appConfig.github ? "on" : "off"}`,
    );
}

// GitHub is two surfaces: publishing (the App) and the tracker tools (the App
// plus a repo allowlist). Saying which is on keeps a silent absence — the
// model answering "I cannot read issues" — from looking like a bug when it is
// a missing list.
if (appConfig.github) {
    logger.info(
        `GitHub App configured: publishing=on, tracker=${
            appConfig.github.repos.length > 0
                ? `on (${appConfig.github.repos.join(",")})`
                : "off (JARVIS_GITHUB_REPOS is empty)"
        }, reviewer=${appConfig.github.reviewer ?? "repository owner"}`,
    );
}

initAgentGraph({
    attachments,
    vision: createVisionModel(getLlmConfig()),
    vlLimiter,
    ...(searchDeps ? { search: searchDeps } : {}),
    ...(weatherDeps ? { weather: weatherDeps } : {}),
    ...(homeAssistantDeps ? { homeAssistant: homeAssistantDeps } : {}),
    ...(wikipediaDeps ? { wikipedia: wikipediaDeps } : {}),
    ...(notifications ? { notifications: { service: notifications } } : {}),
    // The scheduling tools (#90 phase 3) create rows in the same queue the
    // scheduler drains, so they are wired exactly when the loop is: storing a
    // job nobody would run is a promise the server cannot keep. The horizon is
    // the config's days as an instant, because the tools compare moments.
    ...(appConfig.scheduler && notifications
        ? {
              jobs: {
                  ledger: store,
                  maxPerUser: appConfig.scheduler.maxPerUser,
                  maxHorizonMs: appConfig.scheduler.maxHorizonDays * 86_400_000,
              },
          }
        : {}),
    // The owner gate is the store's role, read per call rather than captured:
    // a demoted account must lose the capability immediately, not at restart.
    ...(githubClient && appConfig.github?.repos.length
        ? {
              github: {
                  client: githubClient,
                  repos: appConfig.github.repos,
                  isOwner: (userId: number) =>
                      store.getUserById(userId)?.role === "owner",
              },
          }
        : {}),
    ...(codingJobs
        ? {
              coding: {
                  service: codingJobs,
                  isOwner: (userId: number) =>
                      store.getUserById(userId)?.role === "owner",
                  repos: appConfig.sandbox?.repos ?? [],
              },
          }
        : {}),
});

// The scheduler (#90): one loop over the `jobs` table, running each due job
// through the same agent seam and the same tool instances a chat turn uses.
// Built after the graph so it can be handed those tools, and only when there is
// a notification service to announce a run's outcome with — a loop nobody can
// be told about would be worse than no loop. `JARVIS_SCHEDULER=off` (or
// `JARVIS_NOTIFY=off`) leaves it out entirely.
const scheduler =
    appConfig.scheduler && notifications
        ? createScheduler({
              ledger: store,
              runner: createJobRunner({
                  ledger: store,
                  notifications,
                  tools: getAgentTools(),
                  turnTimeoutMs: appConfig.turnTimeoutMs,
                  maxPerUser: appConfig.scheduler.maxPerUser,
                  maxLatenessMs: appConfig.scheduler.maxLatenessMs,
                  modelRunsPerDay: appConfig.scheduler.modelRunsPerDay,
              }),
              tickMs: appConfig.scheduler.tickMs,
              maxConcurrent: appConfig.scheduler.maxPerTick,
          })
        : undefined;

// The jobs REST surface (#90 phase 5): the same creation policy the tools use,
// over the same ledger, so a page and the model cannot schedule different things.
const jobCreator =
    appConfig.scheduler && notifications
        ? createJobCreator({
              ledger: store,
              maxPerUser: appConfig.scheduler.maxPerUser,
              maxHorizonMs: appConfig.scheduler.maxHorizonDays * 86_400_000,
          })
        : undefined;

// The coding sandbox (#141): the supervisor is built above, before the graph,
// so the `startCodingJob` tool can reach it.
// The sidecar's liveness check exists only in sidecar mode: in embedded mode
// the broker has the ledger in-process, so no HTTP route is needed.
const sidecarSecret =
    appConfig.sandbox?.proxyMode === "sidecar" ? proxySecret : undefined;
const internalRoutes =
    sidecarSecret === undefined
        ? undefined
        : {
              jobState: {
                  verifyToken: (token: string) =>
                      verifyJobToken(sidecarSecret, token),
                  isActive: (jobId: string) => {
                      const job = store.getCodingJobById(jobId);
                      return (
                          job !== null &&
                          (job.state === "queued" || job.state === "running")
                      );
                  },
              },
          };

const webApp = createApp(
    store,
    appConfig,
    attachments,
    inFlight,
    notifications,
    jobCreator,
    codingJobs,
    internalRoutes,
);

const { server } = createJarvisServer(webApp, {
    port,
    host,
    tlsCertPath: appConfig.tlsCertPath,
    tlsKeyPath: appConfig.tlsKeyPath,
    redirectPort: appConfig.httpRedirectPort,
});
attachChatServer(server, store, {
    turnTimeoutMs: appConfig.turnTimeoutMs,
    attachments,
    ...(tts ? { tts, ttsSegment: appConfig.tts?.segment } : {}),
    ...(notificationHub ? { notifications: notificationHub } : {}),
});

// Last, once the socket layer is attached: the first thing `start` does is
// fail the runs a previous process left in flight, and a job firing in the
// same tick can then reach a live hub rather than recording into the void.
void scheduler?.start();
// Coding jobs are reconciled for the same reason: a `running` row belongs to a
// process that died, and its container may still be running (adopt) or not
// (prune). Nothing can start a new job until the tool is wired, so this is the
// only job-path at boot — and it waits for the broker's listener, so an adopted
// container's first model call does not race the bind.
void (sandboxProxy === undefined
    ? Promise.resolve().then(() => codingJobs?.recover())
    : sandboxProxy
          .start()
          .then(() => codingJobs?.recover())
          .catch((err: unknown) => {
              logger.error(
                  `Coding sandbox proxy failed to start: ${
                      err instanceof Error ? err.message : String(err)
                  }`,
              );
              process.exit(1);
          }));
