/**
 * The egress proxy's policy (#141).
 *
 * This is the security boundary that replaces "the container has internet":
 * the address checks are tested as data, because a missed range is a LAN
 * pivot, and the proxy is tested end to end against a local origin so the
 * CONNECT and plain-HTTP paths are real sockets, not mocks.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
    createEgressProxy,
    decideEgress,
    hostAllowed,
    isPublicAddress,
    parseAuthority,
    type EgressProxy,
} from "../src/sandbox/egress";

const servers: Server[] = [];
const proxies: EgressProxy[] = [];

afterEach(async () => {
    for (const proxy of proxies.splice(0)) {
        await proxy.close();
    }
    for (const server of servers.splice(0)) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

/** Starts an HTTP server and returns its port. */
async function listen(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    return (server.address() as AddressInfo).port;
}

/** Sends a CONNECT and reads the status line. */
async function connectStatus(
    proxyPort: number,
    target: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = netConnect({ host: "127.0.0.1", port: proxyPort });
        socket.on("connect", () => {
            socket.write(
                `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`,
            );
        });
        let data = "";
        socket.on("data", (chunk) => {
            data += chunk.toString("utf8");
            socket.destroy();
            resolve(data.split("\r\n")[0] ?? "");
        });
        socket.on("error", reject);
    });
}

describe("isPublicAddress", () => {
    it("allows ordinary public addresses", () => {
        for (const address of [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",
            "2606:4700:4700::1111",
        ]) {
            expect(isPublicAddress(address)).toBe(true);
        }
    });

    it("blocks the host, the LAN, metadata and special ranges", () => {
        for (const address of [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fc00::1",
            "fd12::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::7f00:1",
            "not-an-ip",
        ]) {
            expect(isPublicAddress(address)).toBe(false);
        }
    });
});

describe("hostAllowed", () => {
    it("matches exact hosts, suffix entries and wildcards", () => {
        expect(hostAllowed("registry.npmjs.org", ["registry.npmjs.org"])).toBe(
            true,
        );
        expect(hostAllowed("docs.example.com", [".example.com"])).toBe(true);
        expect(hostAllowed("example.com", [".example.com"])).toBe(true);
        expect(hostAllowed("a.b.example.com", ["*.example.com"])).toBe(true);
        expect(hostAllowed("evil-example.com", [".example.com"])).toBe(false);
        expect(hostAllowed("example.com.evil.test", [".example.com"])).toBe(
            false,
        );
    });
});

describe("decideEgress", () => {
    const resolveTo = (addresses: string[]) => async () =>
        addresses.map((address) => ({ address }));

    it("allows public destinations and returns the checked address", async () => {
        const decision = await decideEgress(
            {
                host: "docs.example.com",
                port: 443,
                policy: "public",
                hosts: [],
            },
            resolveTo(["93.184.216.34"]),
        );

        expect(decision).toEqual({
            allowed: true,
            address: "93.184.216.34",
        });
    });

    it("refuses a public name that resolves to a private address", async () => {
        const decision = await decideEgress(
            {
                host: "docs.example.com",
                port: 443,
                policy: "public",
                hosts: [],
            },
            resolveTo(["127.0.0.1"]),
        );

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain("not a public address");
    });

    it("refuses if any answer is private, not just the first", async () => {
        const decision = await decideEgress(
            {
                host: "docs.example.com",
                port: 443,
                policy: "public",
                hosts: [],
            },
            resolveTo(["93.184.216.34", "10.0.0.5"]),
        );

        expect(decision.allowed).toBe(false);
    });

    it("refuses metadata and odd ports without resolving", async () => {
        const metadata = await decideEgress({
            host: "169.254.169.254",
            port: 443,
            policy: "public",
            hosts: [],
        });
        expect(metadata.allowed).toBe(false);

        const ssh = await decideEgress(
            { host: "example.com", port: 22, policy: "public", hosts: [] },
            resolveTo(["93.184.216.34"]),
        );
        expect(ssh.allowed).toBe(false);
        expect(ssh.reason).toContain("port 22");
    });

    it("checks the allowlist before resolving", async () => {
        let resolved = false;
        const decision = await decideEgress(
            {
                host: "not-listed.example",
                port: 443,
                policy: "allowlist",
                hosts: ["registry.npmjs.org"],
            },
            async () => {
                resolved = true;
                return [{ address: "93.184.216.34" }];
            },
        );

        expect(decision.allowed).toBe(false);
        expect(resolved).toBe(false);
    });

    it("allows an allowlisted public host", async () => {
        const decision = await decideEgress(
            {
                host: "registry.npmjs.org",
                port: 443,
                policy: "allowlist",
                hosts: ["registry.npmjs.org"],
            },
            resolveTo(["104.16.0.1"]),
        );
        expect(decision.allowed).toBe(true);
    });

    it("lets open bypass the checks entirely", async () => {
        const decision = await decideEgress({
            host: "127.0.0.1",
            port: 22,
            policy: "open",
            hosts: [],
        });
        expect(decision).toEqual({ allowed: true });
    });

    it("fails closed when the name does not resolve", async () => {
        const decision = await decideEgress(
            {
                host: "missing.example",
                port: 443,
                policy: "public",
                hosts: [],
            },
            async () => {
                throw new Error("ENOTFOUND");
            },
        );
        expect(decision.allowed).toBe(false);
    });
});

describe("parseAuthority", () => {
    it("reads host, port and bracketed IPv6", () => {
        expect(parseAuthority("example.com:443")).toEqual({
            host: "example.com",
            port: 443,
        });
        expect(parseAuthority("example.com")).toEqual({
            host: "example.com",
            port: 443,
        });
        expect(parseAuthority("[2606:4700::1]:8443")).toEqual({
            host: "2606:4700::1",
            port: 8443,
        });
        expect(parseAuthority("")).toBeNull();
    });
});

describe("the proxy", () => {
    it("forwards a plain HTTP request in open mode", async () => {
        const origin = createServer((_req, res) => res.end("hello"));
        const originPort = await listen(origin);
        const proxy = createEgressProxy({
            bind: "127.0.0.1",
            port: 0,
            policy: "open",
            hosts: [],
        });
        proxies.push(proxy);
        const proxyPort = await proxy.start();

        const body = await new Promise<string>((resolve, reject) => {
            const request = httpRequest(
                {
                    host: "127.0.0.1",
                    port: proxyPort,
                    path: `http://localhost:${originPort}/hello`,
                    headers: { host: `localhost:${originPort}` },
                },
                (response) => {
                    let data = "";
                    response.on("data", (chunk) => {
                        data += chunk.toString();
                    });
                    response.on("end", () => resolve(data));
                },
            );
            request.on("error", reject);
            request.end();
        });

        expect(body).toBe("hello");
    });

    it("tunnels CONNECT to an allowed destination", async () => {
        const origin = createServer((_req, res) => res.end("tunneled"));
        const originPort = await listen(origin);
        const proxy = createEgressProxy({
            bind: "127.0.0.1",
            port: 0,
            policy: "open",
            hosts: [],
        });
        proxies.push(proxy);
        const proxyPort = await proxy.start();

        const status = await connectStatus(
            proxyPort,
            `localhost:${originPort}`,
        );

        expect(status).toContain("200");
    });

    it("refuses CONNECT to metadata in public mode", async () => {
        const proxy = createEgressProxy({
            bind: "127.0.0.1",
            port: 0,
            policy: "public",
            hosts: [],
        });
        proxies.push(proxy);
        const proxyPort = await proxy.start();

        const status = await connectStatus(proxyPort, "169.254.169.254:443");

        expect(status).toContain("403");
    });

    it("refuses a public name that resolves to loopback", async () => {
        const proxy = createEgressProxy({
            bind: "127.0.0.1",
            port: 0,
            policy: "public",
            hosts: [],
            resolve: async () => [{ address: "127.0.0.1" }],
        });
        proxies.push(proxy);
        const proxyPort = await proxy.start();

        const status = await connectStatus(proxyPort, "localhost:443");

        expect(status).toContain("403");
    });
});
