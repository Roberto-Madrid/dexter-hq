import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPgConnectorStore } from "../../hq/connector-pg.ts";
import type { ConnectorStore } from "../../hq/connector-store.ts";
import { databaseUrl, newPool } from "./db.ts";

let pool: pg.Pool;
let store: ConnectorStore;
const owner = randomUUID();

beforeAll(() => {
  pool = newPool();
  store = createPgConnectorStore(databaseUrl());
});

afterAll(async () => {
  await pool.end();
});

describe("request binding (Postgres)", () => {
  it("refuses to store a request bound to both a PR and a branch", async () => {
    const id = randomUUID();
    const base = {
      id,
      ownerId: owner,
      goal: "Bind once.",
      status: "queued" as const,
      card: null,
      evidence: [],
      assignedBotId: null,
      repo: "it/binding",
      notices: [],
    };
    await expect(store.saveRequest({ ...base, pullRequest: "7", branch: "feature/x" })).rejects.toThrow("binding_pr_and_branch");
    expect(await store.getRequest(id)).toBeNull();
    await store.saveRequest({ ...base, pullRequest: "7", branch: null });
    expect((await store.getRequest(id))?.pullRequest).toBe("7");
  });
});
