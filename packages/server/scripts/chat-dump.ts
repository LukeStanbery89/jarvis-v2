/**
 * Local debugging dump for an encrypted conversation (#122).
 *
 * Reads the app database and the development/production key, decrypts the
 * thread's title and transcript, and prints it to stdout. This is deliberately
 * a CLI tool rather than an HTTP route: it is for an operator with filesystem
 * access, and the key never leaves this process.
 *
 * Usage: `npm run chat:dump -- <threadId>` from `packages/server`.
 */
import "dotenv/config";
import { openAppDatabase } from "@lukestanbery/jarvis-auth";
import { createChatCipher, resolveChatKey } from "../src/chatCrypto";
import { defaultAppDbPath } from "../src/config";

const threadId = process.argv[2];
if (!threadId) {
    console.error("usage: npm run chat:dump -- <threadId>");
    process.exit(2);
}

const store = openAppDatabase(process.env.JARVIS_DB_PATH ?? defaultAppDbPath());
try {
    const session = store.getSessionByThread(threadId);
    if (!session) {
        console.error(`no session with thread id ${threadId}`);
        process.exit(1);
    }
    const cipher = createChatCipher(resolveChatKey());
    const title =
        session.title === null ? "(untitled)" : cipher.decrypt(session.title);
    console.log(`# ${title}`);
    console.log(
        `thread=${session.threadId} kind=${session.kind} titleSource=${session.titleSource ?? "none"}`,
    );
    console.log("");

    const rows = store.listChatMessages(session.id, { limit: 1_000_000 });
    for (const row of rows) {
        const payload = JSON.parse(cipher.decrypt(row.payload)) as {
            kind?: string;
            text?: string;
            name?: string;
            output?: unknown;
            error?: boolean;
        };
        if (payload.kind === "tool") {
            console.log(`[tool ${payload.name ?? "tool"}]`);
            console.log(
                typeof payload.output === "string"
                    ? payload.output
                    : JSON.stringify(payload.output, null, 2),
            );
        } else {
            const label = payload.kind === "assistant" ? "assistant" : "user";
            console.log(`[${label}${payload.error ? " error" : ""}]`);
            console.log(payload.text ?? "");
        }
        console.log("");
    }
} finally {
    store.close();
}
