/**
 * Conversation titles (#122): excerpt derivation, model-title sanitizing, and
 * the encrypted title/source transitions.
 */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import { createChatCipher } from "../src/chatCrypto";
import type { ChatHistoryService } from "../src/sessionHistory";
import {
    createSessionTitleService,
    sanitizeModelTitle,
    titleFromPrompt,
} from "../src/sessionTitle";

const cipher = createChatCipher(Buffer.alloc(32, 4));

function setup(
    options: {
        userId?: number | null;
        generate?: () => Promise<string | null>;
    } = {},
) {
    const store = createInMemoryAppDatabase();
    const user =
        options.userId === null
            ? null
            : store.createUser("alice", "hash", "user");
    const session = store.claimSession("thread-1", {
        userId: options.userId === null ? null : user!.id,
        deviceId: null,
        kind: "text",
    }).session;
    const history = {
        firstExchange: () => ({ user: "first question", assistant: "answer" }),
    } as unknown as ChatHistoryService;
    const generate = vi.fn(
        options.generate ?? (async () => "Title: Better chat."),
    );
    const service = createSessionTitleService({
        store,
        history,
        cipher,
        generate,
    });
    return { store, session, service, generate };
}

describe("titleFromPrompt", () => {
    it("strips the attachment marker and collapses whitespace", () => {
        expect(
            titleFromPrompt(
                "  summarize\n\n this   image  \n\n[attachments: a1]",
            ),
        ).toBe("summarize this image");
    });

    it("truncates to the excerpt budget", () => {
        const title = titleFromPrompt("x".repeat(200));
        expect(title.length).toBeLessThanOrEqual(60);
        expect(title.endsWith("…")).toBe(true);
    });
});

describe("sanitizeModelTitle", () => {
    it("removes model decoration and trailing punctuation", () => {
        expect(
            sanitizeModelTitle('  "Title: Debugging the scheduler."  '),
        ).toBe("Debugging the scheduler");
        expect(sanitizeModelTitle("`A short title`")).toBe("A short title");
        expect(sanitizeModelTitle("   ")).toBeNull();
    });

    it("caps the final title length", () => {
        expect(sanitizeModelTitle("x".repeat(100))?.length).toBeLessThanOrEqual(
            80,
        );
    });
});

describe("createSessionTitleService", () => {
    it("stores an encrypted excerpt on the first prompt", () => {
        const { store, session, service } = setup();
        expect(service.ensureExcerpt(session, "Plan my week")).toBe(
            "Plan my week",
        );
        const stored = store.getSessionByThread("thread-1")!;
        expect(stored.titleSource).toBe("excerpt");
        expect(stored.title).not.toContain("Plan my week");
        expect(cipher.decrypt(stored.title!)).toBe("Plan my week");
        // A second prompt does not overwrite the label.
        service.ensureExcerpt(stored, "another prompt");
        expect(
            cipher.decrypt(store.getSessionByThread("thread-1")!.title!),
        ).toBe("Plan my week");
    });

    it("upgrades to a sanitized model title once", async () => {
        const { store, session, service, generate } = setup();
        service.ensureExcerpt(session, "first question");
        const current = store.getSessionByThread("thread-1")!;
        await expect(service.upgrade(current)).resolves.toBe("Better chat");
        const stored = store.getSessionByThread("thread-1")!;
        expect(stored.titleSource).toBe("model");
        expect(cipher.decrypt(stored.title!)).toBe("Better chat");
        await expect(service.upgrade(stored)).resolves.toBeNull();
        expect(generate).toHaveBeenCalledTimes(1);
    });

    it("leaves the excerpt when the model fails", async () => {
        const { store, session, service } = setup({
            generate: async () => {
                throw new Error("model unavailable");
            },
        });
        service.ensureExcerpt(session, "first question");
        const current = store.getSessionByThread("thread-1")!;
        await expect(service.upgrade(current)).resolves.toBeNull();
        expect(store.getSessionByThread("thread-1")!.titleSource).toBe(
            "excerpt",
        );
    });

    it("never titles a guest session", async () => {
        const { session, service, generate } = setup({ userId: null });
        await expect(service.upgrade(session)).resolves.toBeNull();
        expect(generate).not.toHaveBeenCalled();
    });
});
