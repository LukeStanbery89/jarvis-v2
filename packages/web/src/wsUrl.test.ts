import { describe, expect, it } from "vitest";
import { webSocketUrl } from "./wsUrl";

describe("webSocketUrl", () => {
    it("derives a ws URL from an http origin", () => {
        expect(webSocketUrl(new URL("http://localhost:54321/web"))).toBe(
            "ws://localhost:54321/ws",
        );
    });

    it("upgrades to wss under https", () => {
        expect(webSocketUrl(new URL("https://jarvis.lan/web"))).toBe(
            "wss://jarvis.lan/ws",
        );
    });

    it("keeps the port from the page origin", () => {
        expect(webSocketUrl(new URL("http://192.168.1.20:54321/web/"))).toBe(
            "ws://192.168.1.20:54321/ws",
        );
    });
});
