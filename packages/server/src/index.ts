/**
 * Server entry point.
 *
 * Builds the Express app, boots the agent graph (creating `~/.jarvis` and the
 * checkpoint store), opens the app database (users/devices/sessions), hands
 * the app to the listener seam, and attaches the WebSocket chat server.
 *
 * Transport selection, TLS, the cert reads, and the HTTPS redirect listener
 * all live in `src/listener.ts`; this file is a thin composition root.
 */
// Must stay the first import: dotenv loads `.env` into `process.env` before
// `config.ts` reads it. Real environment variables always win over the file.
import "dotenv/config";
import { createApp } from "./app";
import {
    getAppConfig,
    getLlmConfig,
    getServerPort,
    DEFAULT_HOST,
    DEFAULT_ATTACHMENT_CONFIG,
} from "./config";
import { attachChatServer } from "./ws";
import { initAgentGraph } from "./agent";
import { createVisionModel } from "./llm/visionModel";
import { createTavilyClient } from "./llm/tools/search/tavily";
import { createSerperClient } from "./llm/tools/search/serper";
import { createOpenWeatherClient } from "./llm/tools/weather/openweather";
import { createHomeAssistantClient } from "./llm/tools/homeAssistant/client";
import {
    createAttachmentStore,
    sweepOrphanAttachments,
} from "./attachments/store";
import { InFlightLimiter, VlCallLimiter } from "./attachments/limiters";
import { FixedWindowQuota } from "./rate/fixedWindowQuota";
import { KokoroTtsProvider } from "./tts/kokoro";
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

initAgentGraph({
    attachments,
    vision: createVisionModel(getLlmConfig()),
    vlLimiter,
    ...(searchDeps ? { search: searchDeps } : {}),
    ...(weatherDeps ? { weather: weatherDeps } : {}),
    ...(homeAssistantDeps ? { homeAssistant: homeAssistantDeps } : {}),
});
const store = openAppDatabase(appConfig.appDbPath);
const webApp = createApp(store, appConfig, attachments, inFlight);

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
    ...(tts ? { tts } : {}),
});
