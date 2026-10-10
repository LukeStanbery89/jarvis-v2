/**
 * The `analyzeImage` tool: the agent's only window into uploaded images (#10).
 *
 * The chat model is text-only, so when a prompt references an uploaded image
 * the model delegates to this tool, which resolves the attachment, calls the
 * VL model, and returns the analysis as the tool result the model answers
 * from. The tool is created by a **factory** with the attachment store,
 * vision model, and VL-call quota closed over — dependency injection at the
 * tools-registry layer, so tests substitute fakes and the store is never a
 * hidden global (review finding B4).
 *
 * The caller's identity travels through LangGraph's `configurable` (the
 * graph config reaches tool runtime callbacks — verified; there is no
 * AsyncLocalStorage fallback): `ws.ts` stamps `userId` on every
 * authenticated turn, and the tool refuses to run without it. Guests are
 * already rejected at the socket layer for attachment-carrying prompts; this
 * check is defense in depth so a mis-wired graph cannot analyze images
 * un-attributed.
 *
 * Error text returned by this tool is **model-facing**: the model relays it
 * to the user. Each failure kind gets actionable wording ("upload it again")
 * rather than a bare error code, and none of them leak other users' data.
 */
import { tool } from "@langchain/core/tools";
import type { ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import type { AttachmentStore, AttachmentError } from "../../attachments/store";
import { sniffImageMime } from "../../attachments/store";
import type { VisionModel } from "../visionModel";
import type { VlCallLimiter } from "../../attachments/limiters";
import { logger } from "../../logger";

/** Everything the tool needs, injected at wiring time. */
export interface AnalyzeImageDeps {
    /** Resolves attachment ids to bytes (and enforces ownership). */
    attachments: AttachmentStore;
    /** The vision-language model the analysis delegates to. */
    vision: VisionModel;
    /** Per-user cap on analysis calls. */
    vlLimiter: VlCallLimiter;
}

/** User-safe text for each typed attachment failure. */
const FAILURE_TEXT: Record<string, string> = {
    unknown:
        "That image is no longer available (it may have been uploaded before a restart, or the id is wrong). Ask the user to re-upload it.",
    expired:
        "That image has expired — attachments are kept for one hour. Ask the user to upload it again.",
    foreign:
        "That image belongs to a different account and cannot be analyzed.",
};

/**
 * Builds the `analyzeImage` tool over injected dependencies.
 *
 * The tool takes the attachment id (from the prompt's `[attachments: …]`
 * marker) and the user's question verbatim; the model is told to pass the
 * question through so the VL model answers the actual ask rather than
 * describing the image generically.
 */
export function createAnalyzeImageTool(deps: AnalyzeImageDeps) {
    return tool(
        async (
            { attachmentId, query },
            runtime: ToolRuntime,
        ): Promise<string> => {
            const owner = runtime.configurable?.userId;
            if (typeof owner !== "number" || !Number.isInteger(owner)) {
                logger.warn("analyzeImage called without an attachment owner");
                return "Image analysis requires signing in. Ask the user to authenticate and retry.";
            }
            // The quota is checked before any work: a refused call returns
            // text the model can relay (not an exception), so a rate-limited
            // analysis degrades to a "try again in Ns" answer.
            const admission = deps.vlLimiter.tryAcquire(owner);
            if (!admission.ok) {
                const seconds = Math.max(
                    1,
                    Math.ceil(admission.retryAfterMs / 1000),
                );
                return `Image analysis is rate limited — try again in about ${seconds}s.`;
            }
            let bytes: Buffer;
            try {
                bytes = await deps.attachments.get(owner, attachmentId);
            } catch (err) {
                const code = (err as AttachmentError).code;
                if (typeof code === "string" && code in FAILURE_TEXT) {
                    return FAILURE_TEXT[code];
                }
                throw err;
            }
            const mime = sniffImageMime(bytes) ?? "image/png";
            const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
            let analysis: string;
            try {
                analysis = await deps.vision.analyze(dataUrl, query);
            } catch (err) {
                // Every other metered tool maps failures to generic
                // model-facing text; an unguarded throw here would ride
                // LangGraph's tool-error path straight to the client's tool
                // result (internal endpoint/stack detail) with no server
                // log. Log it, and degrade the answer the model relays.
                logger.error(
                    `analyzeImage failed: ${err instanceof Error ? err.message : String(err)}`,
                );
                return "Image analysis failed right now. Tell the user that image analysis is temporarily unavailable and they can try again in a moment.";
            }
            logger.debug(
                `analyzeImage(${attachmentId.slice(0, 6)}…) answered (${analysis.length} chars)`,
            );
            return analysis;
        },
        {
            name: "analyzeImage",
            description:
                "Analyzes an image the user uploaded and referenced in their " +
                "message. Pass the exact `attachmentId` from the message's " +
                "[attachments: …] list and the user's question as `query` " +
                "(verbatim, or a sharpened version of it). Returns a textual " +
                "description/answer about the image contents.",
            schema: z.object({
                attachmentId: z
                    .string()
                    .min(1)
                    .max(32)
                    .describe(
                        "The attachment id from the user's message [attachments: …] list, verbatim",
                    ),
                query: z
                    .string()
                    .min(1)
                    .describe(
                        "What to look at in the image — the user's question verbatim, or a sharpened version of it",
                    ),
            }),
        },
    );
}
