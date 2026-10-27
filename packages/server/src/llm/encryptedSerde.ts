/**
 * Encrypting checkpoint serializer (#122).
 *
 * `SqliteSaver` accepts a {@link SerializerProtocol}; wrapping the stock
 * serializer is enough to make every checkpoint, metadata blob, pending write
 * and task payload opaque at rest without teaching the checkpointer about
 * encryption.
 *
 * The outer payload is base64 text, not raw ciphertext bytes: `SqliteSaver`
 * reads pending writes with `CAST(value AS TEXT)`, and arbitrary binary would
 * be corrupted on that path. The inner serializer's type tag rides inside the
 * encrypted JSON so `loadsTyped` can delegate exactly as the stock serde does.
 *
 * There is deliberately no plaintext fallback. Legacy unencrypted checkpoints
 * are a deployment problem, not a format this server reads.
 */
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type { SerializerProtocol } from "@langchain/langgraph-checkpoint";
import type { ChatCipher } from "../chatCrypto";

/** The checkpoint `type` column value this serializer writes. */
export const ENCRYPTED_CHECKPOINT_TYPE = "jarvis-encrypted-v1";

/** The stock LangChain serializer, borrowed from a saver's default serde. */
function stockSerde(): SerializerProtocol {
    // `BaseCheckpointSaver` owns the default `JsonPlusSerializer` instance and
    // exposes it as `serde`; importing that class directly is not a public
    // subpath, so an in-memory saver is the supported way to obtain it.
    return new MemorySaver().serde;
}

/** The JSON envelope inside the ciphertext. */
interface SerdeEnvelope {
    type: string;
    data: string;
}

/**
 * Builds the encrypting serializer over `cipher`.
 *
 * @param cipher - The shared chat cipher.
 * @returns A `SerializerProtocol` for `SqliteSaver`.
 */
export function createEncryptedSerde(cipher: ChatCipher): SerializerProtocol {
    const inner = stockSerde();
    return {
        async dumpsTyped(data: unknown): Promise<[string, Uint8Array]> {
            const [type, bytes] = await inner.dumpsTyped(data);
            const envelope: SerdeEnvelope = {
                type,
                data: Buffer.from(bytes).toString("base64"),
            };
            const encrypted = cipher.encrypt(JSON.stringify(envelope));
            return [ENCRYPTED_CHECKPOINT_TYPE, Buffer.from(encrypted, "utf8")];
        },
        async loadsTyped(
            type: string,
            data: Uint8Array | string,
        ): Promise<unknown> {
            if (type !== ENCRYPTED_CHECKPOINT_TYPE) {
                throw new Error(
                    `refusing to read unencrypted checkpoint data (type ${type}); purge legacy checkpoints`,
                );
            }
            const encrypted =
                typeof data === "string"
                    ? data
                    : Buffer.from(data).toString("utf8");
            const envelope = JSON.parse(
                cipher.decrypt(encrypted),
            ) as SerdeEnvelope;
            if (
                typeof envelope.type !== "string" ||
                typeof envelope.data !== "string"
            ) {
                throw new Error("encrypted checkpoint envelope is malformed");
            }
            return inner.loadsTyped(
                envelope.type,
                Buffer.from(envelope.data, "base64"),
            );
        },
    };
}
