import { useEffect, useState } from "react";
import { parseFrame, serializeHello } from "@lukestanbery/jarvis-protocol";
import { webSocketUrl } from "./wsUrl";

/**
 * Capabilities this client advertises to the server via its first-frame
 * `hello` announcement: it renders Markdown (which covers text formatting and
 * structure), hyperlinks, and images. Raw HTML is *not* claimed — model text
 * is rendered as Markdown with raw HTML escaped.
 */
const CAPABILITIES = ["markdown", "image", "link"] as const;

/**
 * The web chat client shell.
 *
 * Placeholder UI until the chat surface lands (next PR): on load it dials the
 * chat WebSocket, sends its `hello` capability announcement, and reports the
 * outcome — exercising the full protocol lockstep (client frame → server
 * `hello` handling) end to end.
 */
export function App() {
    const [status, setStatus] = useState("connecting");
    const [detail, setDetail] = useState("");

    useEffect(() => {
        const socket = new WebSocket(webSocketUrl());
        socket.addEventListener("open", () => {
            socket.send(serializeHello([...CAPABILITIES]));
            setStatus("announced");
            setDetail(`capabilities: ${CAPABILITIES.join(", ")}`);
        });
        socket.addEventListener("message", (event) => {
            let frame: ReturnType<typeof parseFrame>;
            try {
                frame = parseFrame(String(event.data));
            } catch (err) {
                setStatus("error");
                setDetail(
                    err instanceof Error
                        ? err.message
                        : "unparsable server frame",
                );
                socket.close();
                return;
            }
            if ("error" in frame) {
                setStatus("error");
                setDetail(frame.error);
                socket.close();
            }
        });
        socket.addEventListener("error", () => {
            setStatus("error");
            setDetail("could not connect to the chat socket");
        });
        return () => {
            socket.close();
        };
    }, []);

    return (
        <main className="shell">
            <h1>J.A.R.V.I.S. Web</h1>
            <p className={status === "error" ? "status error" : "status"}>
                {status === "connecting" && "Connecting…"}
                {status === "announced" && "Connected"}
                {status === "error" && "Connection error"}
            </p>
            {detail && <p className="detail">{detail}</p>}
            <p className="hint">
                Web chat arrives in the next update; for now use the CLI or the
                admin portal.
            </p>
        </main>
    );
}
