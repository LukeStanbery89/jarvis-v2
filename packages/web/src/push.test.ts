/**
 * Web Push helpers (#189 follow-up).
 *
 * The browser's subscription path needs a real PushManager and a user gesture,
 * so the node suite covers the pure half — the VAPID key decoding and the
 * capability gate that keeps a normal iOS Safari tab (where `Notification` and
 * `PushManager` do not exist) on the page-notification path.
 */
import { describe, expect, it } from "vitest";
import { base64UrlToBytes, pushSupported } from "./push";

describe("base64UrlToBytes", () => {
    it("decodes unpadded websafe keys", () => {
        expect([...base64UrlToBytes("AQID")]).toEqual([1, 2, 3]);
        expect([...base64UrlToBytes("-_8")]).toEqual([251, 255]);
    });

    it("accepts padded input too", () => {
        expect([...base64UrlToBytes("AQIDBA==")]).toEqual([1, 2, 3, 4]);
    });
});

describe("pushSupported", () => {
    it("is false outside a browser notification context", () => {
        expect(pushSupported()).toBe(false);
    });
});
