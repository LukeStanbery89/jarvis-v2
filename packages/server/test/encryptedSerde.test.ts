/**
 * Encrypting checkpoint serializer (#122): the outer envelope is text (so
 * SqliteSaver's `CAST(value AS TEXT)` pending-write path stays intact), the
 * inner serializer is preserved, and legacy plaintext is refused.
 */
import Database from "better-sqlite3";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { describe, expect, it } from "vitest";
import { createChatCipher } from "../src/chatCrypto";
import {
    createEncryptedSerde,
    ENCRYPTED_CHECKPOINT_TYPE,
} from "../src/llm/encryptedSerde";

const cipher = createChatCipher(Buffer.alloc(32, 3));

describe("createEncryptedSerde", () => {
    it("round-trips a JSON value without exposing its plaintext", async () => {
        const serde = createEncryptedSerde(cipher);
        const value = { message: "top secret", n: 42 };
        const [type, bytes] = await serde.dumpsTyped(value);
        expect(type).toBe(ENCRYPTED_CHECKPOINT_TYPE);
        expect(Buffer.from(bytes).toString("utf8")).not.toContain("top secret");
        expect(await serde.loadsTyped(type, bytes)).toEqual(value);
    });

    it("accepts the text form SqliteSaver reads back", async () => {
        const serde = createEncryptedSerde(cipher);
        const [type, bytes] = await serde.dumpsTyped({ ok: true });
        const asText = Buffer.from(bytes).toString("utf8");
        expect(await serde.loadsTyped(type, asText)).toEqual({ ok: true });
    });

    it("round-trips the inner byte type", async () => {
        const serde = createEncryptedSerde(cipher);
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const [type, encoded] = await serde.dumpsTyped(bytes);
        expect(Array.from(await serde.loadsTyped(type, encoded))).toEqual([
            1, 2, 3, 4,
        ]);
    });

    it("refuses a legacy plaintext checkpoint", async () => {
        const serde = createEncryptedSerde(cipher);
        await expect(
            serde.loadsTyped("json", Buffer.from('{"old":true}')),
        ).rejects.toThrow(/purge legacy checkpoints/);
    });

    it("works through SqliteSaver, including its text-cast pending writes", async () => {
        const db = new Database(":memory:");
        const saver = new SqliteSaver(db, createEncryptedSerde(cipher));
        const checkpoint = emptyCheckpoint();
        checkpoint.channel_values = {
            messages: [{ secret: "the checkpoint secret" }],
        };
        const config = await saver.put(
            { configurable: { thread_id: "thread-1" } },
            checkpoint,
            { source: "input", step: 0, parents: {} },
        );
        await saver.putWrites(
            config,
            [["messages", { secret: "the pending-write secret" }]],
            "task-1",
        );

        const raw = db
            .prepare(
                "SELECT type, checkpoint FROM checkpoints WHERE thread_id = 'thread-1'",
            )
            .get() as { type: string; checkpoint: Buffer };
        expect(raw.type).toBe(ENCRYPTED_CHECKPOINT_TYPE);
        expect(raw.checkpoint.toString("utf8")).not.toContain(
            "the checkpoint secret",
        );

        const tuple = await saver.getTuple({
            configurable: { thread_id: "thread-1" },
        });
        expect(
            (
                tuple?.checkpoint.channel_values.messages as {
                    secret: string;
                }[]
            )[0].secret,
        ).toBe("the checkpoint secret");
        expect(tuple?.pendingWrites?.[0]?.[1]).toBe("messages");
        expect(tuple?.pendingWrites?.[0]?.[2]).toEqual({
            secret: "the pending-write secret",
        });
        db.close();
    });
});
