/**
 * The `sendNotification` tool (#139): the agent's way to reach the user
 * outside its reply.
 *
 * This is the first real producer. The notification channel shipped with
 * nothing to raise a notification; this tool is the simplest thing that does,
 * and it deliberately goes through the same {@link NotificationService} a
 * scheduler job or a webhook will use. Nothing here decides anything — the
 * policy that governs whether an interruption is *allowed* (the user's own
 * switch, quiet hours, presence, the delivery budget) keeps its one home in
 * the service, and this tool inherits it and reports the answer.
 *
 * Two deliberate limits:
 *
 * - **Announcements only.** `requiresAnswer` is not exposed. An answerable
 *   notification records the user's reply, and nothing consumes it yet, so a
 *   tool that asked the user a question would promise a round-trip the system
 *   cannot make. That round-trip is the async "needs input while working" case
 *   (#94); when there is somewhere for an answer to go, this argument is what
 *   exposes it.
 * - **No caller quota.** The resources here are interruptions and rows, and
 *   both are already capped downstream (`deliveriesPerWindow`, `maxPerUser`),
 *   so a second ceiling on *calls* would only add a way for the model to be
 *   refused a no-op. Identity is still required, though: a notification is
 *   addressed to an account, and a guest has none — so a guest is refused in
 *   the same words the metered tools use ({@link requireSignedInUser}).
 */
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { requireSignedInUser } from "./metering";
import type { NotificationService } from "../../notify/service";
import {
    NotificationInputError,
    type NotifyOutcome,
    type NotificationSuppression,
} from "../../notify/types";

/** Everything the tool needs, injected at wiring time. */
export interface NotifyToolDeps {
    /** The notification service, as wired for this process. */
    service: NotificationService;
}

/**
 * The `kind` every agent-raised notification carries.
 *
 * Fixed rather than model-chosen: `kind` is the producer's stable category
 * (the REST schema calls it "job.finished", "reminder"), it is what grouping,
 * filtering and future per-category preferences key off, and a model that
 * invented one per call would make all three useless. There is one agent
 * producer, so there is one token.
 */
export const AGENT_NOTIFICATION_KIND = "agent.request";

/**
 * Why a recorded notification was not pushed, in the service's own vocabulary.
 *
 * Exhaustive over {@link NotificationSuppression} on purpose: adding a reason
 * to the union should be a compile error here, not a silent fallback to some
 * generic sentence the model then relays as if it were the truth.
 */
const SUPPRESSION_REASON: Record<
    Exclude<NotificationSuppression, null>,
    string
> = {
    disabled: "the user has notifications switched off",
    "quiet-hours":
        "it is inside their quiet hours, so it waits for them to end",
    absent: "no client of theirs is connected right now",
    cap: "their notification budget for this minute is spent",
};

/**
 * Renders one delivery outcome as model-facing text.
 *
 * Pure and exported for tests. The model is told what actually happened,
 * because the alternative — a bare "sent" — makes it claim an interruption
 * that never occurred, and the user's next question is then "where?" A
 * notification that was recorded but not pushed is not a failure (`pending` is
 * the normal state for an unreachable user), so the text says where it is
 * waiting rather than apologizing.
 */
export function formatNotifyOutcome(outcome: NotifyOutcome): string {
    if (outcome.delivered > 0) {
        const clients = outcome.delivered === 1 ? "client" : "clients";
        return `Delivered to ${outcome.delivered} connected ${clients}.`;
    }
    if (outcome.suppressed === null) {
        // Unreachable by construction (no delivery always states a reason),
        // but the model must never be told it arrived; a bare "recorded" is
        // the honest fallback.
        return "Recorded in the user's notification list, but not pushed to a live client.";
    }
    return (
        `Recorded in the user's notification list, but not pushed: ` +
        `${SUPPRESSION_REASON[outcome.suppressed]}. Tell the user it is ` +
        `waiting there rather than that it appeared.`
    );
}

/**
 * Builds the `sendNotification` tool over the injected service.
 *
 * The model writes the words; the service decides the delivery. Every failure
 * is a returned string rather than a thrown error (except a cancelled turn,
 * which must reject — #103), so a refusal degrades into something the model
 * can relay instead of a broken turn.
 */
export function createNotifyTool(deps: NotifyToolDeps) {
    return tool(
        async (
            { title, body, priority },
            runtime: ToolRuntime,
        ): Promise<string> => {
            const guard = requireSignedInUser(runtime, {
                subject: "Notifications",
                logName: "sendNotification",
            });
            if (!guard.ok) {
                return guard.text;
            }
            try {
                const outcome = await deps.service.notify(guard.userId, {
                    kind: AGENT_NOTIFICATION_KIND,
                    title,
                    ...(body !== undefined && body.length > 0 ? { body } : {}),
                    ...(priority !== undefined ? { priority } : {}),
                });
                logger.debug(
                    `sendNotification → delivered ${outcome.delivered} (suppressed: ${outcome.suppressed ?? "no"})`,
                );
                return formatNotifyOutcome(outcome);
            } catch (err) {
                // A cancelled turn rejects down the graph's bare-done path
                // rather than handing the model "could not send" to relay.
                runtime.signal?.throwIfAborted();
                if (err instanceof NotificationInputError) {
                    return `The notification was not sent: ${err.message}. Fix that argument and call again.`;
                }
                logger.warn(
                    `sendNotification failed — ${err instanceof Error ? err.message : "unexpected error"}`,
                );
                return "The notification could not be sent. Tell the user plainly that it did not go out.";
            }
        },
        {
            name: "sendNotification",
            description:
                "Reaches the user outside this conversation: a banner in " +
                "their chat client, and a desktop notification when they are " +
                "not looking at that client. Use it when the user asked you " +
                "to notify them, or when you are about to spend long enough " +
                "on something that they may walk away from the screen before " +
                "you are finished — the notification is what finds them. Do " +
                "not use it to acknowledge a request, to restate the reply " +
                "you are about to send, or more than once for the same thing: " +
                "the user is already reading your reply, and a notification " +
                "is an interruption they have to act on. Write `title` as one " +
                "short line that stands on its own — it is the headline they " +
                "see — and put any detail in `body`. `priority` defaults to " +
                "'normal': 'low' for something that can wait, 'high' only " +
                "when it genuinely cannot, since 'high' interrupts the " +
                "user's quiet hours while 'low' and 'normal' wait for them to " +
                "end. The result says whether a connected client received it: " +
                "if it reports the notification was not pushed, tell the user " +
                "it is waiting in their notification list instead of saying " +
                "it appeared.",
            schema: z.object({
                title: z
                    .string()
                    .describe(
                        "The headline, one short line written to be read on " +
                            "its own (for example 'Research on the Vosk " +
                            "model is ready')",
                    ),
                body: z
                    .string()
                    .optional()
                    .describe(
                        "Optional detail shown under the headline. Leave it " +
                            "out when the title says enough.",
                    ),
                priority: z
                    .enum(["low", "normal", "high"])
                    .optional()
                    .describe(
                        "'low', 'normal' (the default), or 'high' — how much " +
                            "this may interrupt. 'high' interrupts quiet " +
                            "hours; use it only when it truly cannot wait.",
                    ),
            }),
        },
    );
}
