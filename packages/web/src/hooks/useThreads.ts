/**
 * Transcript-store plumbing for the chat view.
 *
 * Holds the action union the view dispatches and the reducer that applies each
 * action through the pure `threads.ts` helpers. It lives in a hook-named
 * module because the next phase wraps it in `useThreads`; for now it is pure
 * (no React import) and node-testable.
 */
import {
    appendChunk,
    appendMessage,
    appendToolResult,
    deleteThread,
    ensureThread,
    markAssistantError,
    type ThreadMap,
} from "../threads";

/** Transcript-store actions, all flowing through the pure threads helpers. */
export type ThreadsAction =
    | {
          type: "user";
          sessionId: string;
          text: string;
          at: number;
          attachmentIds?: string[];
      }
    | { type: "chunk"; sessionId: string; text: string; at: number }
    | {
          type: "tool";
          sessionId: string;
          name: string;
          args?: unknown;
          at: number;
      }
    | {
          type: "toolResult";
          sessionId: string;
          name: string;
          output?: unknown;
          at: number;
      }
    | { type: "assistantError"; sessionId: string; text: string; at: number }
    | { type: "ensure"; sessionId: string; at: number }
    | { type: "deleted"; sessionId: string };

/**
 * Applies one action via the pure helpers (reducer for the thread map).
 *
 * @param map - The current thread map.
 * @param action - The action to apply.
 * @returns The next thread map.
 */
export function threadsReducer(
    map: ThreadMap,
    action: ThreadsAction,
): ThreadMap {
    switch (action.type) {
        case "user":
            return appendMessage(map, action.sessionId, {
                id: crypto.randomUUID(),
                role: "user",
                text: action.text,
                at: action.at,
                ...(action.attachmentIds?.length
                    ? { attachmentIds: action.attachmentIds }
                    : {}),
            });
        case "chunk":
            return appendChunk(map, action.sessionId, action.text, action.at);
        case "tool":
            return appendMessage(map, action.sessionId, {
                id: crypto.randomUUID(),
                role: "tool",
                tool: { name: action.name, args: action.args },
                at: action.at,
            });
        case "toolResult":
            return appendToolResult(
                map,
                action.sessionId,
                action.name,
                action.output,
                action.at,
            );
        case "assistantError":
            return markAssistantError(
                map,
                action.sessionId,
                action.text,
                action.at,
            );
        case "ensure":
            return ensureThread(map, action.sessionId, action.at);
        case "deleted":
            return deleteThread(map, action.sessionId);
    }
}
