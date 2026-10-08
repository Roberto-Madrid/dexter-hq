import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { readFileSync } from "node:fs";
import { CONNECTOR_TOOLS, callConnectorTool, createDefaultConnectorDeps } from "../../hq/connector.ts";
import { createPgConnectorStore } from "../../hq/connector-pg.ts";
import type { ConnectorAuth, ConnectorStore } from "../../hq/connector-store.ts";
import { isHandoffRequest, planHandoffLaunch } from "../../hq/handoff-launch.ts";
import { TOOL_OUTPUT_MAX_CHARS } from "../../hq/tool-artifacts.ts";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import { databaseUrl, newPool } from "./db.ts";

const ALL = [...CONNECTOR_TOOLS];
const OWNER = randomUUID();
const REPO = `it-${OWNER.slice(0, 8)}/shop`;
const SHA = "fedcba9876543210fedcba9876543210fedcba98";
const NOW = "2026-10-08T12:00:00.000Z";

function bot(name: string, repos: string[]): ConnectorAuth {
  return { id: randomUUID(), ownerId: OWNER, name, kind: "lead", repos, tools: ALL, currentTask: null, heartbeatAt: null, scopes: ALL, suspended: false };
}

const lead = bot("it-shop-lead", [REPO]);
const stranger = bot("it-other-lead", ["it-other/repo"]);
let pool: pg.Pool;
let store: ConnectorStore;

beforeAll(() => {
  pool = newPool();
  store = createPgConnectorStore(databaseUrl());
});

afterAll(async () => {
  await pool.query("delete from public.posts where owner_id = $1", [OWNER]);
  await pool.query("delete from public.requests where owner_id = $1", [OWNER]);
  await pool.end();
});

describe("handoff bundle artifact (Postgres)", () => {
  it("stores a bundle larger than the tool-output cap whole, readable on the mission only", async () => {
    const requestId = randomUUID();
    const request = {
      id: requestId,
      ownerId: OWNER,
      goal: "Move the shop to maintenance.",
      status: "queued",
      card: { crew: "handoff" },
      evidence: [],
      assignedBotId: lead.id,
      repo: REPO,
      notices: [],
    };
    await store.saveRequest(request);
    // launch_agent reads the crew back from the stored request.
    expect(isHandoffRequest(await store.getRequest(requestId))).toBe(true);
    const files = new Map([
      ["AGENTS.md", "# Shop\nKeep checkout working."],
      ["README.md", `# Shop\n${"Bookings flow notes. ".repeat(900)}`],
      ["docs/DEPLOY.md", `# Deploy\n${"Deploy steps. ".repeat(900)}`],
      ["package.json", JSON.stringify({ scripts: { test: "vitest run" } })],
    ]);
    const planned = await planHandoffLaunch({
      store,
      sheet: parseRoleSheet(readFileSync("gateway/role-sheet.yaml", "utf8")),
      source: async () => ({ sha: SHA, files }),
      auth: lead,
      request,
      repo: REPO,
      ref: null,
      family: "grok",
      brief: "Take over maintenance.",
      now: NOW,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    await planned.plan.commit();
    const { artifactId, chars } = planned.plan.summary;
    expect(chars).toBeGreaterThan(TOOL_OUTPUT_MAX_CHARS);

    const deps = createDefaultConnectorDeps({ store, cursor: null, cursorConfigured: false, checker: null, ownerId: OWNER, now: () => NOW });
    let text = "";
    let offset: number | null = 0;
    while (offset !== null) {
      const page = (await callConnectorTool(deps, lead, "get_context", { artifactId, offset })).structuredContent as {
        artifact: { text: string; nextOffset: number | null; storedChars: number; truncated: boolean };
      };
      expect(page.artifact.truncated).toBe(false);
      expect(page.artifact.storedChars).toBe(chars);
      text += page.artifact.text;
      offset = page.artifact.nextOffset;
    }
    expect(text).toHaveLength(chars);
    expect(text.startsWith(`# Maintenance handoff: ${REPO} at ${SHA}`)).toBe(true);

    const refused = await callConnectorTool(deps, stranger, "get_context", { artifactId });
    expect(refused.structuredContent).toMatchObject({ reason: "unknown_artifact" });
    const post = await pool.query("select type from public.posts where owner_id = $1", [OWNER]);
    expect(post.rows).toEqual([{ type: "handoff" }]);
    expect((await store.getPost(planned.plan.summary.postId))?.requestId).toBe(requestId);
  });
});
