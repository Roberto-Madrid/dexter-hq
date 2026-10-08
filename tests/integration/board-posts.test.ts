import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { callConnectorTool, createDefaultConnectorDeps, CONNECTOR_TOOLS } from "../../hq/connector.ts";
import { createPgConnectorStore } from "../../hq/connector-pg.ts";
import type { ConnectorAuth } from "../../hq/connector-store.ts";
import { databaseUrl, newPool } from "./db.ts";

const ALL = [...CONNECTOR_TOOLS];
const OWNER = randomUUID();
const REPO = `it-${OWNER.slice(0, 8)}/alpha`;
const OTHER_REPO = `it-${OWNER.slice(0, 8)}/beta`;
const NOW = "2026-10-08T09:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;

function bot(name: string, kind: string, repos: string[]): ConnectorAuth {
  return { id: randomUUID(), ownerId: OWNER, name, kind, repos, tools: ALL, currentTask: null, heartbeatAt: null, scopes: ALL, suspended: false };
}

const lead = bot("it-alpha-lead", "lead", [REPO]);
const dev = bot("it-alpha-dev", "other", [REPO]);
const otherLead = bot("it-beta-lead", "lead", [OTHER_REPO]);

type Note = { id: string };
type Body = { [key: string]: unknown; findings: Note[]; deadEnds: Note[] };

let pool: pg.Pool;

beforeAll(() => {
  pool = newPool();
});

afterAll(async () => {
  await pool.query("delete from public.posts where owner_id = $1", [OWNER]);
  await pool.end();
});

describe("posts round trip through Postgres", () => {
  it("writes status, verified_by, expires_at, created_at and provenance, and reads them back", async () => {
    let clock = NOW;
    const store = createPgConnectorStore(databaseUrl());
    const deps = createDefaultConnectorDeps({ store, cursor: null, cursorConfigured: false, checker: null, ownerId: OWNER, now: () => clock });
    const call = async (auth: ConnectorAuth, name: string, args: Record<string, unknown>) =>
      (await callConnectorTool(deps, auth, name, args)).structuredContent as Body;

    const finding = await call(lead, "post", {
      type: "finding",
      body: "token sk-abcdefghijklmnopqrst must not land",
      repo: REPO,
      agentId: "bc-1",
      sha: "abcdef1",
      link: "https://github.com/acme/alpha/pull/1",
      idempotencyKey: "it-1",
    });
    expect(finding.status).toBe("posted");
    const again = await call(lead, "post", { type: "finding", body: "token sk-abcdefghijklmnopqrst must not land", repo: REPO, idempotencyKey: "it-1" });
    expect(again.postId).toBe(finding.postId);

    const raw = await pool.query("select type, author, status, verified_by, expires_at, created_at, evidence from public.posts where id = $1", [finding.postId]);
    expect(raw.rows).toHaveLength(1);
    const row = raw.rows[0];
    expect(row.status).toBe("claimed");
    expect(row.verified_by).toBeNull();
    expect(row.expires_at).toBeNull();
    expect(new Date(row.created_at).toISOString()).toBe(NOW);
    expect(row.evidence).toMatchObject({ repo: REPO, scope: "project", authorId: lead.id, agentId: "bc-1", sha: "abcdef1" });
    expect(JSON.stringify(row.evidence)).not.toContain("sk-abcdefghijklmnopqrst");

    expect((await call(lead, "verify_post", { postId: finding.postId })).reason).toBe("same_author");
    expect((await call(otherLead, "verify_post", { postId: finding.postId })).reason).toBe("unknown_post");
    const verified = await call(dev, "verify_post", { postId: finding.postId });
    expect(verified.status).toBe("verified");
    const after = await pool.query("select status, verified_by, created_at from public.posts where id = $1", [finding.postId]);
    expect(after.rows[0]).toMatchObject({ status: "verified", verified_by: "it-alpha-dev" });
    expect(new Date(after.rows[0].created_at).toISOString()).toBe(NOW);

    const dead = await call(lead, "post", { type: "dead_end", body: "pnpm on CI", conditions: "until lockfile v9", expiresInDays: 1, repo: REPO });
    const deadRow = await pool.query("select expires_at, status from public.posts where id = $1", [dead.postId]);
    expect(new Date(deadRow.rows[0].expires_at).toISOString()).toBe(new Date(Date.parse(NOW) + DAY).toISOString());

    const live = await call(dev, "get_context", { repo: REPO });
    expect(live.findings.map((item) => item.id)).toEqual([finding.postId]);
    expect(live.deadEnds.map((item) => item.id)).toEqual([dead.postId]);
    expect((await call(otherLead, "get_context", { repo: REPO })).reason).toBe("repo_out_of_scope");
    const otherView = await call(otherLead, "get_context", {});
    expect(JSON.stringify(otherView)).not.toContain(String(finding.postId));

    clock = new Date(Date.parse(NOW) + 2 * DAY).toISOString();
    const later = await call(dev, "get_context", { repo: REPO });
    expect(later.deadEnds).toEqual([]);
    expect(later.findings.map((item) => item.id)).toEqual([finding.postId]);
  });
});
