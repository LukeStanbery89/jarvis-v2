/**
 * Returns the current date and time in ISO 8601 format (UTC).
 *
 * The LLM has no other way to know "now", so this is its clock. Deliberately
 * non-deterministic.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const getCurrentTime = tool(async () => new Date().toISOString(), {
    name: "getCurrentTime",
    description:
        "Returns the current date and time in ISO 8601 format (UTC). " +
        "Use when asked what time it is or what today's date is.",
    schema: z.object({}),
});
