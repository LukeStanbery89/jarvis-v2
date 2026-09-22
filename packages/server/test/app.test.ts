import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createApp } from "../src/app";
import { SqliteAppStore } from "../src/auth";

const store = new SqliteAppStore(new Database(":memory:"));

afterAll(() => {
    store.close();
});

describe("app", () => {
    it("returns 'Hello World' from GET /", async () => {
        const res = await request(
            createApp(store, {
                appDbPath: ":memory:",
                turnTimeoutMs: 30_000,
                bootstrapToken: undefined,
            }),
        ).get("/");
        expect(res.status).toBe(200);
        expect(res.text).toBe("Hello World");
    });
});
