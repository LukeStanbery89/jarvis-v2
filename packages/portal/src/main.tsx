/** Portal entry: mounts the App into `#root`. */
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
    throw new Error("#root element missing from index.html");
}
createRoot(root).render(<App />);
