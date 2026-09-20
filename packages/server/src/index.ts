import { createApp } from "./app";

const port = Number(process.env.PORT ?? 54321);

createApp().listen(port, () => {
    console.log(`Jarvis server listening on http://localhost:${port}`);
});
