/**
 * The job's only door to the internet (#141).
 *
 * A sidecar network is `--internal`: the job container has no route off it and
 * no DNS. Everything it wants from outside must pass through this forward
 * proxy, which is the point — the job may research docs and install packages,
 * but it must not reach the host, the LAN, cloud metadata, or an arbitrary
 * port.
 *
 * **The policy is by destination class, not by name.** An allowlist cannot
 * cover "any API or library", so the default (`public`) allows HTTP(S) to
 * public addresses and refuses everything private, loopback, link-local or
 * documentation-reserved. Hostnames are resolved here, every answer is
 * checked, and the connection is made to the checked address — so a DNS
 * rebinding cannot swap a public name for `127.0.0.1` after the check.
 *
 * `allowlist` is the stricter option for a deployment that wants it, and
 * `open` exists as the escape hatch. The job never chooses: this is
 * configuration, because a model that could widen its own egress would be one
 * prompt injection away from doing so.
 */
import { lookup } from "node:dns/promises";
import {
    createServer,
    request as httpRequest,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import { connect as netConnect, isIP } from "node:net";
import type { Duplex } from "node:stream";

/** How a destination is judged. */
export type EgressPolicy = "public" | "allowlist" | "open";

/** One decision, for the log and the response. */
export interface EgressDecision {
    readonly allowed: boolean;
    /** The address to connect to; absent for `open` (resolve at connect). */
    readonly address?: string;
    readonly reason?: string;
}

/** What the proxy needs. */
export interface EgressProxyOptions {
    /** Interface to listen on — the internal network's, in the sidecar. */
    bind: string;
    /** Port jobs point `HTTP_PROXY` at. */
    port: number;
    /** The policy. */
    policy: EgressPolicy;
    /** Host allowlist, used by `allowlist` (exact, suffix, or `*.` form). */
    hosts: readonly string[];
    /** A decision observer, for the audit log (tests pass nothing). */
    onDecision?: (event: {
        host: string;
        port: number;
        allowed: boolean;
        reason?: string;
    }) => void;
    /** Resolver override, for tests. */
    resolve?: (host: string) => Promise<ReadonlyArray<{ address: string }>>;
}

/** The proxy's lifecycle, matching the broker's shape. */
export interface EgressProxy {
    /** Binds the listener; returns the bound port. */
    start(): Promise<number>;
    /** Stops accepting and closes live connections. */
    close(): Promise<void>;
}

/** The only ports a job may reach; docs and registries all live here. */
const ALLOWED_PORTS = new Set([80, 443]);

/** Connect timeout for an upstream destination. */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Whether an address is on the public internet.
 *
 * IPv4 special-purpose ranges are blocked by their registries' reservations;
 * IPv6 blocks loopback, unique-local, link-local, multicast, documentation,
 * and every IPv4-mapped form (a mapped address is an IPv4 destination in
 * disguise, and no legitimate public service is reached that way).
 *
 * @param address - An IPv4 or IPv6 literal.
 * @returns True when a job may connect to it.
 */
export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) {
        const octets = address.split(".").map(Number);
        const [a, b, c] = octets;
        if (
            a === undefined ||
            b === undefined ||
            c === undefined ||
            octets.some(
                (part) => !Number.isInteger(part) || part < 0 || part > 255,
            )
        ) {
            return false;
        }
        if (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 0 && (c === 0 || c === 2)) ||
            (a === 192 && b === 88 && c === 99) ||
            (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19)) ||
            (a === 198 && b === 51 && c === 100) ||
            (a === 203 && b === 0 && c === 113) ||
            a >= 224
        ) {
            return false;
        }
        return true;
    }
    if (family === 6) {
        const value = address.toLowerCase();
        if (value === "::" || value === "::1") {
            return false;
        }
        // IPv4-mapped and NAT64 forms reach an IPv4 address; treat them as one
        // and refuse rather than trying to decode every spelling.
        if (
            value.startsWith("::ffff:") ||
            value.startsWith("64:ff9b:") ||
            value.startsWith("2001:db8")
        ) {
            return false;
        }
        if (value.startsWith("fc") || value.startsWith("fd")) {
            return false;
        }
        if (/^fe[89ab]/.test(value) || value.startsWith("ff")) {
            return false;
        }
        return true;
    }
    return false;
}

/**
 * Whether a host matches the allowlist.
 *
 * Entries are hostnames; `.example.com` and `*.example.com` match the domain
 * and its subdomains, a bare name matches only itself.
 *
 * @param host - The requested hostname (case-insensitive).
 * @param entries - The configured entries.
 * @returns True when the host is allowed.
 */
export function hostAllowed(host: string, entries: readonly string[]): boolean {
    const wanted = host.toLowerCase().replace(/\.$/, "");
    return entries.some((raw) => {
        const entry = raw.trim().toLowerCase().replace(/\.$/, "");
        if (entry.length === 0) {
            return false;
        }
        if (entry.startsWith("*.")) {
            const suffix = entry.slice(1);
            return wanted === entry.slice(2) || wanted.endsWith(suffix);
        }
        if (entry.startsWith(".")) {
            return wanted === entry.slice(1) || wanted.endsWith(entry);
        }
        return wanted === entry;
    });
}

/**
 * Decides whether one destination may be reached.
 *
 * Resolution happens here (the job has no DNS), every answer must be public,
 * and the returned address is what the caller connects to — the hostname is
 * never re-resolved by the kernel.
 *
 * @param input - Host, port, policy and allowlist.
 * @param resolve - The resolver (tests replace it).
 * @returns The decision.
 */
export async function decideEgress(
    input: {
        host: string;
        port: number;
        policy: EgressPolicy;
        hosts: readonly string[];
    },
    resolve: (host: string) => Promise<ReadonlyArray<{ address: string }>> = (
        host,
    ) => lookup(host, { all: true }),
): Promise<EgressDecision> {
    const host = input.host.toLowerCase();
    if (input.policy === "open") {
        return { allowed: true };
    }
    if (!ALLOWED_PORTS.has(input.port)) {
        return { allowed: false, reason: `port ${input.port} is not allowed` };
    }
    if (input.policy === "allowlist" && !hostAllowed(host, input.hosts)) {
        return {
            allowed: false,
            reason: "host is not on the egress allowlist",
        };
    }
    let addresses: ReadonlyArray<{ address: string }>;
    if (isIP(host) !== 0) {
        addresses = [{ address: host }];
    } else {
        try {
            addresses = await resolve(host);
        } catch {
            return { allowed: false, reason: "the name did not resolve" };
        }
    }
    if (addresses.length === 0) {
        return { allowed: false, reason: "the name did not resolve" };
    }
    const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
    if (blocked !== undefined) {
        return {
            allowed: false,
            reason: `${blocked.address} is not a public address`,
        };
    }
    const first = addresses[0];
    if (first === undefined) {
        return { allowed: false, reason: "the name did not resolve" };
    }
    return { allowed: true, address: first.address };
}

/**
 * Splits a CONNECT target (`host:port`, `[v6]:port`).
 *
 * @param target - The request's authority.
 * @returns The host and port, or `null`.
 */
export function parseAuthority(
    target: string,
): { host: string; port: number } | null {
    const trimmed = target.trim();
    if (trimmed.startsWith("[")) {
        const end = trimmed.indexOf("]");
        if (end === -1) {
            return null;
        }
        const host = trimmed.slice(1, end);
        const rest = trimmed.slice(end + 1);
        const port = rest.startsWith(":") ? Number(rest.slice(1)) : 443;
        return host.length > 0 && Number.isInteger(port) && port > 0
            ? { host, port }
            : null;
    }
    const colon = trimmed.lastIndexOf(":");
    if (colon === -1) {
        return trimmed.length > 0 ? { host: trimmed, port: 443 } : null;
    }
    const host = trimmed.slice(0, colon);
    const port = Number(trimmed.slice(colon + 1));
    return host.length > 0 && Number.isInteger(port) && port > 0
        ? { host, port }
        : null;
}

/**
 * Builds the forward proxy.
 *
 * @param options - Bind, port, policy and observer.
 * @returns The proxy.
 */
export function createEgressProxy(options: EgressProxyOptions): EgressProxy {
    const resolve = options.resolve;
    let server: Server | null = null;

    const decide = async (
        host: string,
        port: number,
    ): Promise<EgressDecision> => {
        const input = {
            host,
            port,
            policy: options.policy,
            hosts: options.hosts,
        };
        const decision =
            resolve !== undefined
                ? await decideEgress(input, resolve)
                : await decideEgress(input);
        options.onDecision?.({
            host,
            port,
            allowed: decision.allowed,
            ...(decision.reason !== undefined
                ? { reason: decision.reason }
                : {}),
        });
        return decision;
    };

    /** Forwards one plain-HTTP request to a checked address. */
    const forwardHttp = (
        req: IncomingMessage,
        res: ServerResponse,
        target: URL,
        address: string | undefined,
    ): void => {
        const port = target.port === "" ? 80 : Number(target.port);
        const headers = { ...req.headers };
        delete headers["proxy-connection"];
        delete headers.connection;
        headers.host = target.host;
        const upstream = httpRequest(
            {
                host: address ?? target.hostname,
                port,
                method: req.method,
                path: `${target.pathname}${target.search}`,
                headers,
            },
            (response) => {
                res.writeHead(response.statusCode ?? 502, response.headers);
                response.pipe(res);
            },
        );
        upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
            upstream.destroy(new Error("upstream timed out"));
        });
        upstream.on("error", () => {
            if (!res.headersSent) {
                res.writeHead(502, { "content-type": "text/plain" });
            }
            res.end("egress proxy: upstream failed");
        });
        req.pipe(upstream);
    };

    /** Tunnels a CONNECT after the destination checked out. */
    const tunnel = (
        client: Duplex,
        host: string,
        port: number,
        address: string | undefined,
        head: Buffer,
    ): void => {
        const upstream = netConnect({
            host: address ?? host,
            port,
        });
        upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
            upstream.destroy(new Error("upstream timed out"));
        });
        upstream.on("connect", () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length > 0) {
                upstream.write(head);
            }
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.on("error", () => {
            client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        });
        client.on("error", () => {
            upstream.destroy();
        });
    };

    return {
        async start(): Promise<number> {
            const instance = createServer((req, res) => {
                let target: URL;
                try {
                    target = new URL(req.url ?? "");
                } catch {
                    res.writeHead(400, { "content-type": "text/plain" });
                    res.end("egress proxy: absolute URL expected");
                    return;
                }
                if (target.protocol !== "http:") {
                    res.writeHead(400, { "content-type": "text/plain" });
                    res.end("egress proxy: only http is proxied directly");
                    return;
                }
                const port = target.port === "" ? 80 : Number(target.port);
                void decide(target.hostname, port).then((decision) => {
                    if (!decision.allowed) {
                        res.writeHead(403, { "content-type": "text/plain" });
                        res.end(`egress proxy: ${decision.reason ?? "denied"}`);
                        return;
                    }
                    forwardHttp(req, res, target, decision.address);
                });
            });

            instance.on("connect", (req, client, head) => {
                const authority = parseAuthority(req.url ?? "");
                if (authority === null) {
                    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
                    return;
                }
                void decide(authority.host, authority.port).then((decision) => {
                    if (!decision.allowed) {
                        client.end(
                            `HTTP/1.1 403 Forbidden\r\n\r\negress proxy: ${
                                decision.reason ?? "denied"
                            }\r\n`,
                        );
                        return;
                    }
                    tunnel(
                        client,
                        authority.host,
                        authority.port,
                        decision.address,
                        head,
                    );
                });
            });

            await new Promise<void>((resolveStart, rejectStart) => {
                instance.once("error", rejectStart);
                instance.listen(options.port, options.bind, () => {
                    instance.off("error", rejectStart);
                    resolveStart();
                });
            });
            server = instance;
            const address = instance.address();
            return typeof address === "object" && address !== null
                ? address.port
                : options.port;
        },

        async close(): Promise<void> {
            const instance = server;
            if (instance === null) {
                return;
            }
            server = null;
            await new Promise<void>((resolveClose) => {
                instance.close(() => resolveClose());
            });
        },
    };
}
