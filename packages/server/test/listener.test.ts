import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createJarvisServer, validateRedirectPort } from "../src/listener";
import { logger } from "../src/logger";

const healthApp = () => {
    const app = express();
    app.get("/", (_req, res) => res.send("ok"));
    return app;
};

describe("validateRedirectPort", () => {
    it("keeps a valid explicit port", () => {
        expect(validateRedirectPort(8081, 443)).toBe(8081);
    });

    it("falls back to port + 1 for unset / NaN / non-positive / colliding values", () => {
        expect(validateRedirectPort(undefined, 54321)).toBe(54322);
        expect(validateRedirectPort(Number.NaN, 54321)).toBe(54322);
        expect(validateRedirectPort(0, 54321)).toBe(54322);
        expect(validateRedirectPort(54321, 54321)).toBe(54322);
    });
});

describe("createJarvisServer", () => {
    it("serves plain HTTP and is actually listening", async () => {
        const listener = createJarvisServer(healthApp(), {
            port: 0,
            host: "127.0.0.1",
        });
        expect(listener.scheme).toBe("http");
        expect(listener.url).toBe("http://localhost:0");
        await new Promise<void>((resolve, reject) =>
            listener.server.once("listening", resolve).once("error", reject),
        );
        expect(listener.server.address()).not.toBeNull();
        listener.server.close();
    });

    it("warns and falls back to plain HTTP when TLS is half-set", () => {
        const error = vi.spyOn(logger, "error").mockImplementation(() => {});
        const listener = createJarvisServer(healthApp(), {
            port: 0,
            host: "127.0.0.1",
            tlsCertPath: "/tmp/only-cert.pem",
        });
        expect(listener.scheme).toBe("http");
        expect(error).toHaveBeenCalledOnce();
        expect(String(error.mock.calls[0][0])).toContain("JARVIS_TLS_CERT");
        error.mockRestore();
        listener.server.close();
    });
});
