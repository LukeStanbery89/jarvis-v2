import type { AddressInfo } from "net";
import { afterEach, describe, expect, it } from "vitest";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import {
    askLoginDetails,
    defaultDeviceName,
    loginRequest,
    sanitizeDeviceName,
} from "../src/login";

/** The device-name bound the server enforces (`DEVICE_NAME_MAX`). */
const DEVICE_NAME_MAX = 64;

interface LoginServer {
    url: string;
    close: () => void;
}

/**
 * Starts an ephemeral HTTP server that answers `POST /api/auth/login` via
 * `handler` and returns a WS-style URL for it (one server per test so ports
 * never collide).
 */
async function withLoginServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LoginServer> {
    const server: Server = createServer((req, res) => {
        if (req.method === "POST" && req.url === "/api/auth/login") {
            handler(req, res);
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    return {
        url: `ws://127.0.0.1:${port}/ws`,
        close: () => server.close(),
    };
}

/** Collects the raw request body of `req`. */
function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}

/** Sends `payload` as JSON with `status`. */
function json(res: ServerResponse, status: number, payload: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
}

const INPUTS = {
    username: "luke",
    password: "correct horse",
    deviceName: "macbook",
};

afterEach(() => {
    delete process.env.JARVIS_SERVER_URL;
});

describe("loginRequest", () => {
    it("posts the credentials and returns the normalized result", async () => {
        let seenBody = "";
        let seenAuth = "";
        const { url, close } = await withLoginServer(async (req, res) => {
            seenAuth = req.headers["content-type"] ?? "";
            seenBody = await readBody(req);
            json(res, 200, {
                user: { id: 1, username: "luke", role: "owner" },
                device: {
                    id: 2,
                    name: "macbook",
                    prefix: "abcd",
                    token: "tok-1",
                },
            });
        });
        try {
            const result = await loginRequest(url, INPUTS);

            expect(result).toEqual({
                user: "luke",
                device: "macbook",
                token: "tok-1",
            });
            expect(seenAuth).toContain("application/json");
            expect(JSON.parse(seenBody)).toEqual(INPUTS);
        } finally {
            close();
        }
    });

    it("passes through the server's error message on 401", async () => {
        const { url, close } = await withLoginServer((_req, res) => {
            json(res, 401, { error: "invalid username or password" });
        });
        try {
            await expect(loginRequest(url, INPUTS)).rejects.toThrow(
                /invalid username or password/,
            );
        } finally {
            close();
        }
    });

    it("passes through the rate-limit message on 429", async () => {
        const { url, close } = await withLoginServer((_req, res) => {
            json(res, 429, { error: "too many attempts; try again later" });
        });
        try {
            await expect(loginRequest(url, INPUTS)).rejects.toThrow(
                /too many attempts/,
            );
        } finally {
            close();
        }
    });

    it("passes through the bootstrap hint on 404", async () => {
        const { url, close } = await withLoginServer((_req, res) => {
            json(res, 404, {
                error: "no owner configured; bootstrap before logging in",
            });
        });
        try {
            await expect(loginRequest(url, INPUTS)).rejects.toThrow(
                /bootstrap before logging in/,
            );
        } finally {
            close();
        }
    });

    it("falls back to a status message when the error body is not JSON", async () => {
        const { url, close } = await withLoginServer((_req, res) => {
            res.statusCode = 500;
            res.end("boom");
        });
        try {
            await expect(loginRequest(url, INPUTS)).rejects.toThrow(
                /login failed \(HTTP 500\)/,
            );
        } finally {
            close();
        }
    });

    it("rejects a success body that is not the expected shape", async () => {
        const { url, close } = await withLoginServer((_req, res) => {
            json(res, 200, { hello: 1 });
        });
        try {
            await expect(loginRequest(url, INPUTS)).rejects.toThrow(
                /unexpected login response/,
            );
        } finally {
            close();
        }
    });

    it("reports an unreachable server", async () => {
        // Port 1 is a well-known closed port on 127.0.0.1.
        await expect(
            loginRequest("ws://127.0.0.1:1/ws", INPUTS),
        ).rejects.toThrow(/could not reach/);
    });

    it("times out when the server accepts but stalls", async () => {
        // A server that never answers: fetch aborts after the given timeout.
        const server = createServer(() => {
            /* hold the request open */
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const port = (server.address() as AddressInfo).port;
        try {
            await expect(
                loginRequest(`ws://127.0.0.1:${port}/ws`, INPUTS, 50),
            ).rejects.toThrow(/timed out reaching/);
        } finally {
            server.close();
        }
    });
});

describe("sanitizeDeviceName", () => {
    it("strips the .local mDNS suffix", () => {
        expect(sanitizeDeviceName("macbook.local")).toBe("macbook");
        expect(sanitizeDeviceName("macbook.local.")).toBe("macbook");
    });

    it("drops characters outside [a-zA-Z0-9._-]", () => {
        expect(sanitizeDeviceName("My Mac!")).toBe("MyMac");
        expect(sanitizeDeviceName("pi 3 b+")).toBe("pi3b");
    });

    it("truncates to the server's device-name bound", () => {
        const long = "x".repeat(100);
        expect(sanitizeDeviceName(long).length).toBe(DEVICE_NAME_MAX);
    });

    it("falls back to 'cli' when nothing usable remains", () => {
        expect(sanitizeDeviceName("!!!")).toBe("cli");
        expect(sanitizeDeviceName("")).toBe("cli");
    });
});

describe("defaultDeviceName", () => {
    it("returns a non-empty name within the server's bound", () => {
        const name = defaultDeviceName();
        expect(name.length).toBeGreaterThan(0);
        expect(name.length).toBeLessThanOrEqual(DEVICE_NAME_MAX);
    });
});

describe("askLoginDetails", () => {
    /** A minimal readline stub that answers each `question` from `answers`. */
    function stubRl(answers: string[]): {
        rl: Parameters<typeof askLoginDetails>[0];
        questions: string[];
    } {
        const questions: string[] = [];
        const rl = {
            question: (q: string, cb: (a: string) => void) => {
                questions.push(q);
                cb(answers.shift() ?? "");
            },
        } as unknown as Parameters<typeof askLoginDetails>[0];
        return { rl, questions };
    }

    /** An askHidden stub that returns its scripted answer without echoing. */
    const hidden = (answer: string) => async (): Promise<string> => answer;

    it("cancels when the username is empty and no default was given", async () => {
        const { rl, questions } = stubRl([""]);

        const result = await askLoginDetails(rl, hidden("x"));
        expect(result).toBeNull();
        expect(questions).toEqual(["Username: "]);
    });

    it("collects the full credential set with defaults applied", async () => {
        const { rl, questions } = stubRl(["", ""]);
        const deviceDefault = defaultDeviceName();

        const result = await askLoginDetails(
            rl,
            hidden("correct horse"),
            "luke",
        );
        expect(result).toEqual({
            username: "luke",
            password: "correct horse",
            deviceName: deviceDefault,
        });
        expect(questions[0]).toBe("Username [luke]: ");
        expect(questions[1]).toBe(`Device name [${deviceDefault}]: `);
    });

    it("truncates an overly long device name to the server's bound", async () => {
        const { rl } = stubRl(["luke", "d".repeat(100)]);

        const result = await askLoginDetails(rl, hidden("pw"), "luke");
        expect(result?.deviceName.length).toBe(DEVICE_NAME_MAX);
    });
});
