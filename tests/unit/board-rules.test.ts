import { describe, expect, it } from "vitest";
import { CONTEXT_LIMITS, scrubSecrets } from "../../hq/board-notes.ts";
import {
  CONNECTOR_TOOLS,
  callConnectorTool,
  createDefaultConnectorDeps,
  createMemoryConnectorStore,
  loadConnectorSheetText,
} from "../../hq/connector.ts";
import type { ConnectorAuth, ConnectorStore } from "../../hq/connector-store.ts";
import { POST_TYPES, verifyFinding } from "../../kernel/board.ts";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "99999999-9999-4999-8999-999999999999";
const NOW = "2026-10-08T09:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const SHA = "abcdef1234567abcdef1234567abcdef12345678";
const ALPHA = "acme/alpha";
const BETA = "acme/beta";
const ALL = [...CONNECTOR_TOOLS];

type Note = Record<string, string>;
type Body = {
  [key: string]: unknown;
  findings: Note[];
  claimed: Note[];
  deadEnds: Note[];
  handoffs: Note[];
};

function bot(id: string, name: string, kind: string, repos: string[], ownerId = OWNER): ConnectorAuth {
  return { id, ownerId, name, kind, repos, tools: ALL, currentTask: null, heartbeatAt: null, scopes: ALL, suspended: false };
}

const leadA = bot("aaaaaaaa-0000-4000-8000-000000000001", "alpha-lead", "lead", [ALPHA]);
const devA = bot("aaaaaaaa-0000-4000-8000-000000000002", "alpha-dev", "other", [ALPHA]);
const leadB = bot("bbbbbbbb-0000-4000-8000-000000000001", "beta-lead", "lead", [BETA]);
const ceo = bot("cccccccc-0000-4000-8000-000000000001", "dexter", "ceo", []);
const scout = bot("dddddddd-0000-4000-8000-000000000001", "scout", "scout", []);
const stranger = bot("eeeeeeee-0000-4000-8000-000000000001", "stranger-ceo", "ceo", [], OTHER_OWNER);

function setup(now = NOW) {
  const store = createMemoryConnectorStore({ bots: [leadA, devA, leadB, ceo, scout, stranger] });
  let clock = now;
  const deps = createDefaultConnectorDeps({
    store,
    sheet: parseRoleSheet(loadConnectorSheetText()),
    cursor: null,
    cursorConfigured: false,
    checker: null,
    checkerConfigured: false,
    ownerId: OWNER,
    now: () => clock,
  });
  return {
    store,
    deps,
    at(next: string) {
      clock = next;
    },
    async call(auth: ConnectorAuth, name: string, args: Record<string, unknown>) {
      const result = await callConnectorTool(deps, auth, name, args);
      return { body: result.structuredContent as Body, isError: result.isError };
    },
  };
}

async function request(store: ConnectorStore, id: string, repo: string | null, assignedBotId: string | null, passed = false) {
  await store.saveRequest({
    id,
    ownerId: OWNER,
    goal: "goal",
    status: "running",
    card: null,
    evidence: [],
    assignedBotId,
    repo,
    notices: [],
    checkRun: repo
      ? { nonce: "n", githubRunId: "1", sha: SHA, repo, hostRepo: "acme/workers", dispatchedAt: NOW, passed }
      : null,
  });
}

function ids(list: unknown): string[] {
  return ((list as { id: string }[]) ?? []).map((item) => item.id);
}

function allNotes(body: Body): Note[] {
  return [...(body.findings ?? []), ...(body.claimed ?? []), ...(body.deadEnds ?? []), ...(body.handoffs ?? [])];
}

describe("kernel post types", () => {
  it("adds shortcut and lets a different author verify it", () => {
    expect(POST_TYPES).toContain("shortcut");
    const post = { type: "shortcut" as const, status: "claimed" as const, author: "a" };
    expect(verifyFinding(post, { author: "a", deterministic: false })).toEqual({ ok: false, reason: "same_author" });
    expect(verifyFinding(post, { author: "b", deterministic: false }).ok).toBe(true);
    expect(verifyFinding({ type: "dead_end", status: null, author: "a" }, { author: "b", deterministic: false })).toEqual({
      ok: false,
      reason: "not_a_finding",
    });
  });
});

describe("post: typed notes", () => {
  it("refuses a type outside finding, dead_end, shortcut, handoff", async () => {
    const t = setup();
    for (const type of ["rumor", "alert", "question", ""]) {
      const out = await t.call(leadA, "post", { type, body: "x", repo: ALPHA });
      expect(out.isError).toBe(true);
      expect(out.body.reason).toBe("invalid_type");
      expect(out.body.allowed).toEqual(["finding", "dead_end", "shortcut", "handoff"]);
    }
    const missing = await t.call(leadA, "post", { body: "no type", repo: ALPHA });
    expect(missing.body.reason).toBe("invalid_type");
    expect(await t.store.listPosts()).toHaveLength(0);
  });

  it("refuses an empty body and a body over the cap", async () => {
    const t = setup();
    expect((await t.call(leadA, "post", { type: "finding", repo: ALPHA })).body.reason).toBe("body_required");
    const long = await t.call(leadA, "post", { type: "finding", body: "x".repeat(2001), repo: ALPHA });
    expect(long.body.reason).toBe("body_too_long");
  });

  it("stores findings and shortcuts as claimed with scope, author, provenance and created_at", async () => {
    const t = setup();
    await request(t.store, "req-1", ALPHA, leadA.id);
    const out = await t.call(leadA, "post", {
      type: "shortcut",
      body: "Run vitest with --changed to skip unrelated suites.",
      requestId: "req-1",
      agentId: "bc-123",
      runId: "run-9",
      sha: SHA,
      link: "https://github.com/acme/alpha/pull/4",
    });
    expect(out.isError).toBe(false);
    expect(out.body).toMatchObject({ status: "posted", type: "shortcut", noteStatus: "claimed", scope: "project", repo: ALPHA });
    const row = await t.store.getPost(String(out.body.postId));
    expect(row).toMatchObject({
      type: "shortcut",
      author: "alpha-lead",
      authorId: leadA.id,
      ownerId: OWNER,
      repo: ALPHA,
      scope: "project",
      status: "claimed",
      verified: false,
      verifiedBy: null,
      requestId: "req-1",
      agentId: "bc-123",
      runId: "run-9",
      sha: SHA,
      link: "https://github.com/acme/alpha/pull/4",
      createdAt: NOW,
    });
    const finding = await t.call(leadA, "post", { type: "finding", body: "The build needs node 22.", repo: ALPHA });
    expect((await t.store.getPost(String(finding.body.postId)))?.status).toBe("claimed");
  });

  it("refuses a malformed sha or link", async () => {
    const t = setup();
    expect((await t.call(leadA, "post", { type: "finding", body: "b", sha: "nothex!" })).body.reason).toBe("invalid_sha");
    expect((await t.call(leadA, "post", { type: "finding", body: "b", link: "javascript:alert(1)" })).body.reason).toBe(
      "invalid_link",
    );
  });

  it("is idempotent per author and key", async () => {
    const t = setup();
    const first = await t.call(leadA, "post", { type: "finding", body: "same", repo: ALPHA, idempotencyKey: "k1" });
    const second = await t.call(leadA, "post", { type: "finding", body: "same", repo: ALPHA, idempotencyKey: "k1" });
    expect(second.body.postId).toBe(first.body.postId);
    expect(second.body.idempotent).toBe(true);
    expect(await t.store.listPosts()).toHaveLength(1);
    const other = await t.call(devA, "post", { type: "finding", body: "same", repo: ALPHA, idempotencyKey: "k1" });
    expect(other.body.postId).not.toBe(first.body.postId);
  });
});

describe("post: dead ends", () => {
  it("needs a condition", async () => {
    const t = setup();
    const out = await t.call(leadA, "post", { type: "dead_end", body: "Playwright on alpine", repo: ALPHA });
    expect(out.isError).toBe(true);
    expect(out.body.reason).toBe("dead_end_needs_condition");
  });

  it("always stores an expiry: default 30 days, never in the past, at most 180 days", async () => {
    const t = setup();
    const base = { type: "dead_end", body: "Playwright on alpine", conditions: "until the image ships glibc", repo: ALPHA };
    const dflt = await t.call(leadA, "post", base);
    expect(dflt.body.expiresAt).toBe(new Date(Date.parse(NOW) + 30 * DAY).toISOString());
    expect((await t.store.getPost(String(dflt.body.postId)))?.expiresAt).toBe(dflt.body.expiresAt);
    expect((await t.store.getPost(String(dflt.body.postId)))?.conditions).toBe("until the image ships glibc");
    const days = await t.call(leadA, "post", { ...base, expiresInDays: 2 });
    expect(days.body.expiresAt).toBe(new Date(Date.parse(NOW) + 2 * DAY).toISOString());
    const past = await t.call(leadA, "post", { ...base, expiresAt: "2026-10-01T00:00:00.000Z" });
    expect(past.body.reason).toBe("expiry_in_past");
    const far = await t.call(leadA, "post", { ...base, expiresInDays: 181 });
    expect(far.body.reason).toBe("expiry_too_far");
    const bad = await t.call(leadA, "post", { ...base, expiresAt: "soon" });
    expect(bad.body.reason).toBe("invalid_expiry");
  });
});

describe("post: secret scrub", () => {
  it("redacts secret-shaped text in body, conditions and link before storing", async () => {
    const t = setup();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl";
    const body = [
      "key sk-abcdefghijklmnopqrst",
      "gh ghp_abcdefghijklmnopqrstuvwxyz",
      `jwt ${jwt}`,
      "db postgres://app:hunter2pass@db.example.com:5432/app",
      "Authorization: Bearer abcdefghijklmnopqrstuvwx123",
    ].join("\n");
    const out = await t.call(leadA, "post", {
      type: "dead_end",
      body,
      conditions: "while sk-abcdefghijklmnopqrst is live",
      link: "https://example.com/?token=ghp_abcdefghijklmnopqrstuvwxyz",
      repo: ALPHA,
    });
    expect(out.body.redacted).toBe(true);
    const row = await t.store.getPost(String(out.body.postId));
    const stored = JSON.stringify(row);
    for (const secret of ["sk-abcdefghijklmnopqrst", "ghp_abcdefghijklmnopqrstuvwxyz", jwt, "hunter2pass", "abcdefghijklmnopqrstuvwx123"]) {
      expect(stored).not.toContain(secret);
    }
    expect(row?.body).toContain("[redacted]");
    const events = JSON.stringify(await t.store.listEvents());
    expect(events).not.toContain("sk-abcdefghijklmnopqrst");
    expect(scrubSecrets("plain text stays")).toBe("plain text stays");
  });
});

describe("post: scopes", () => {
  it("defaults a lead's post to its venture and refuses another venture's repo", async () => {
    const t = setup();
    const own = await t.call(leadA, "post", { type: "finding", body: "alpha fact" });
    expect(own.body).toMatchObject({ scope: "project", repo: ALPHA });
    const cross = await t.call(leadA, "post", { type: "finding", body: "beta fact", repo: BETA });
    expect(cross.isError).toBe(true);
    expect(cross.body.reason).toBe("repo_out_of_scope");
  });

  it("needs shared to be explicit when there is no repo", async () => {
    const t = setup();
    expect((await t.call(ceo, "post", { type: "finding", body: "fleet fact" })).body.reason).toBe("scope_required");
    expect((await t.call(scout, "post", { type: "finding", body: "fleet fact" })).body.reason).toBe("scope_required");
    const shared = await t.call(scout, "post", { type: "finding", body: "fleet fact", scope: "shared" });
    expect(shared.body).toMatchObject({ status: "posted", scope: "shared" });
    expect(shared.body.repo).toBeUndefined();
    expect((await t.call(scout, "post", { type: "finding", body: "x", repo: ALPHA })).body.reason).toBe("repo_out_of_scope");
    expect((await t.call(scout, "post", { type: "finding", body: "x", scope: "everyone" })).body.reason).toBe("invalid_scope");
  });

  it("only lets the request's bot or the CEO post a mission note", async () => {
    const t = setup();
    await request(t.store, "req-a", ALPHA, leadA.id);
    const mine = await t.call(leadA, "post", { type: "handoff", body: "next: wire the route", scope: "mission", requestId: "req-a" });
    expect(mine.body).toMatchObject({ scope: "mission", requestId: "req-a", repo: ALPHA });
    expect((await t.call(leadB, "post", { type: "finding", body: "x", scope: "mission", requestId: "req-a" })).body.reason).toBe(
      "request_out_of_scope",
    );
    expect((await t.call(leadA, "post", { type: "finding", body: "x", scope: "mission" })).body.reason).toBe("request_required");
    expect((await t.call(leadA, "post", { type: "finding", body: "x", scope: "mission", requestId: "nope" })).body.reason).toBe(
      "unknown_request",
    );
    expect((await t.call(ceo, "post", { type: "finding", body: "x", scope: "mission", requestId: "req-a" })).body.status).toBe(
      "posted",
    );
  });
});

describe("verify_post", () => {
  it("refuses a self-verify and keeps the note claimed", async () => {
    const t = setup();
    const post = await t.call(leadA, "post", { type: "finding", body: "alpha fact", repo: ALPHA });
    const self = await t.call(leadA, "verify_post", { postId: post.body.postId });
    expect(self.isError).toBe(true);
    expect(self.body.reason).toBe("same_author");
    expect((await t.store.getPost(String(post.body.postId)))?.status).toBe("claimed");
  });

  it("lets a different bot that can see the note verify it, once, and records its name", async () => {
    const t = setup();
    const post = await t.call(leadA, "post", { type: "shortcut", body: "use --changed", repo: ALPHA });
    const ok = await t.call(devA, "verify_post", { postId: post.body.postId });
    expect(ok.body).toMatchObject({ status: "verified", postId: post.body.postId, verifiedBy: "alpha-dev", via: "bot" });
    const row = await t.store.getPost(String(post.body.postId));
    expect(row).toMatchObject({ status: "verified", verified: true, verifiedBy: "alpha-dev" });
    const again = await t.call(ceo, "verify_post", { postId: post.body.postId });
    expect(again.body.reason).toBe("not_claimed");
    expect((await t.store.getPost(String(post.body.postId)))?.verifiedBy).toBe("alpha-dev");
  });

  it("hides another venture's note from a lead's verify", async () => {
    const t = setup();
    const post = await t.call(leadA, "post", { type: "finding", body: "alpha fact", repo: ALPHA });
    const out = await t.call(leadB, "verify_post", { postId: post.body.postId });
    expect(out.body.reason).toBe("unknown_post");
    const foreign = await t.call(stranger, "verify_post", { postId: post.body.postId });
    expect(foreign.body.reason).toBe("unknown_post");
  });

  it("refuses dead ends and handoffs", async () => {
    const t = setup();
    const dead = await t.call(leadA, "post", { type: "dead_end", body: "x", conditions: "always", repo: ALPHA });
    expect((await t.call(ceo, "verify_post", { postId: dead.body.postId })).body.reason).toBe("not_a_finding");
  });

  it("accepts the Checker: a passed check on the note's own request and repo", async () => {
    const t = setup();
    await request(t.store, "req-pass", ALPHA, leadA.id, true);
    await request(t.store, "req-red", ALPHA, leadA.id, false);
    const post = await t.call(leadA, "post", { type: "finding", body: "fix works", repo: ALPHA, requestId: "req-pass", sha: SHA });
    const red = await t.call(leadA, "verify_post", { postId: post.body.postId, checkRequestId: "req-red" });
    expect(red.body.reason).toBe("check_mismatch");
    const other = await t.call(leadA, "post", { type: "finding", body: "other", repo: ALPHA, requestId: "req-red" });
    expect((await t.call(leadA, "verify_post", { postId: other.body.postId, checkRequestId: "req-red" })).body.reason).toBe(
      "check_not_passed",
    );
    const ok = await t.call(leadA, "verify_post", { postId: post.body.postId, checkRequestId: "req-pass" });
    expect(ok.body).toMatchObject({ status: "verified", verifiedBy: "checker", via: "checker" });
  });
});

describe("get_context: scopes", () => {
  async function seed(t: ReturnType<typeof setup>) {
    await request(t.store, "req-a", ALPHA, leadA.id);
    await request(t.store, "req-b", BETA, leadB.id);
    await request(t.store, "req-s", null, scout.id);
    const alpha = await t.call(leadA, "post", { type: "finding", body: "alpha project", repo: ALPHA });
    const beta = await t.call(leadB, "post", { type: "finding", body: "beta project", repo: BETA });
    const shared = await t.call(leadA, "post", { type: "finding", body: "shared tip", repo: ALPHA, scope: "shared" });
    const mission = await t.call(leadA, "post", { type: "handoff", body: "alpha mission", scope: "mission", requestId: "req-a" });
    const scoutMission = await t.call(scout, "post", { type: "finding", body: "scout mission", scope: "mission", requestId: "req-s" });
    return {
      alpha: String(alpha.body.postId),
      beta: String(beta.body.postId),
      shared: String(shared.body.postId),
      mission: String(mission.body.postId),
      scoutMission: String(scoutMission.body.postId),
    };
  }

  it("refuses a lead reading another venture's repo or request", async () => {
    const t = setup();
    await seed(t);
    const repo = await t.call(leadB, "get_context", { repo: ALPHA });
    expect(repo.isError).toBe(true);
    expect(repo.body.reason).toBe("repo_out_of_scope");
    const req = await t.call(leadB, "get_context", { requestId: "req-a" });
    expect(req.body.reason).toBe("request_out_of_scope");
    expect((await t.call(scout, "get_context", { repo: ALPHA })).body.reason).toBe("repo_out_of_scope");
  });

  it("gives a lead shared + its venture + its missions, never another venture", async () => {
    const t = setup();
    const p = await seed(t);
    const b = await t.call(leadB, "get_context", {});
    expect(ids(allNotes(b.body))).toEqual(expect.arrayContaining([p.beta, p.shared]));
    expect(ids(allNotes(b.body))).not.toContain(p.alpha);
    expect(ids(allNotes(b.body))).not.toContain(p.mission);
    expect(ids(allNotes(b.body))).not.toContain(p.scoutMission);
    const a = await t.call(leadA, "get_context", { repo: ALPHA, requestId: "req-a" });
    expect(ids(allNotes(a.body))).toEqual(expect.arrayContaining([p.alpha, p.shared, p.mission]));
    expect(ids(allNotes(a.body))).not.toContain(p.beta);
    const dev = await t.call(devA, "get_context", { repo: ALPHA });
    expect(ids(allNotes(dev.body))).toContain(p.alpha);
    expect(ids(allNotes(dev.body))).not.toContain(p.mission);
  });

  it("gives Scout shared + its missions, and the CEO everything for its owner", async () => {
    const t = setup();
    const p = await seed(t);
    const s = await t.call(scout, "get_context", {});
    expect(ids(allNotes(s.body)).sort()).toEqual([p.shared, p.scoutMission].sort());
    const c = await t.call(ceo, "get_context", {});
    expect(ids(allNotes(c.body)).sort()).toEqual(Object.values(p).sort());
    const foreign = await t.call(stranger, "get_context", {});
    expect(allNotes(foreign.body)).toHaveLength(0);
  });
});

describe("get_context: claimed notes are marked, not facts", () => {
  it("lists claimed notes apart from verified findings with a rule line", async () => {
    const t = setup();
    const post = await t.call(leadA, "post", { type: "finding", body: "maybe true", repo: ALPHA });
    const before = await t.call(ceo, "get_context", {});
    expect(before.body.findings).toEqual([]);
    expect(ids(before.body.claimed)).toEqual([post.body.postId]);
    expect(before.body.claimed[0].status).toBe("claimed");
    expect(before.body.unverified).toEqual([post.body.postId]);
    expect(String(before.body.rule)).toMatch(/claimed/i);
    expect(String(before.body.rule)).toMatch(/not .*plan|never change a plan/i);
    await t.call(devA, "verify_post", { postId: post.body.postId });
    const after = await t.call(ceo, "get_context", {});
    expect(ids(after.body.findings)).toEqual([post.body.postId]);
    expect(after.body.findings[0].status).toBe("verified");
    expect(after.body.findings[0].verifiedBy).toBe("alpha-dev");
    expect(after.body.claimed).toEqual([]);
  });
});

describe("get_context: ranking and compactness", () => {
  it("ranks verified first, then mission > repo > shared, then newest first", async () => {
    const t = setup();
    await request(t.store, "req-a", ALPHA, leadA.id);
    t.at("2026-10-01T00:00:00.000Z");
    const sharedOld = await t.call(leadA, "post", { type: "finding", body: "shared old", scope: "shared" });
    const verifiedOld = await t.call(leadA, "post", { type: "finding", body: "verified old", scope: "shared" });
    t.at("2026-10-02T00:00:00.000Z");
    const repoOld = await t.call(leadA, "post", { type: "finding", body: "repo old", repo: ALPHA });
    const missionOld = await t.call(leadA, "post", { type: "finding", body: "mission old", scope: "mission", requestId: "req-a" });
    t.at("2026-10-05T00:00:00.000Z");
    const repoNew = await t.call(leadA, "post", { type: "shortcut", body: "repo new", repo: ALPHA });
    const sharedNew = await t.call(leadA, "post", { type: "finding", body: "shared new", scope: "shared" });
    await t.call(devA, "verify_post", { postId: verifiedOld.body.postId });
    t.at(NOW);
    const out = await t.call(leadA, "get_context", { repo: ALPHA, requestId: "req-a" });
    expect(ids(out.body.findings)).toEqual([verifiedOld.body.postId]);
    expect(ids(out.body.claimed)).toEqual([
      missionOld.body.postId,
      repoNew.body.postId,
      repoOld.body.postId,
      sharedNew.body.postId,
      sharedOld.body.postId,
    ]);
  });

  it("caps count, body length and total size, and says how many it left out", async () => {
    const t = setup();
    for (let index = 0; index < 40; index += 1) {
      await t.call(leadA, "post", { type: "finding", body: `${index} ${"long text ".repeat(150)}`, repo: ALPHA });
    }
    const out = await t.call(leadA, "get_context", { repo: ALPHA });
    const notes = allNotes(out.body) as { body: string }[];
    expect(notes.length).toBeLessThanOrEqual(CONTEXT_LIMITS.defaultNotes);
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) expect(note.body.length).toBeLessThanOrEqual(CONTEXT_LIMITS.bodyChars);
    expect(out.body.omitted).toBe(40 - notes.length);
    expect(JSON.stringify(notes).length).toBeLessThanOrEqual(CONTEXT_LIMITS.totalChars);
    const wide = await t.call(leadA, "get_context", { repo: ALPHA, limit: 500 });
    expect(allNotes(wide.body).length).toBeLessThanOrEqual(CONTEXT_LIMITS.maxNotes);
    expect(JSON.stringify(allNotes(wide.body)).length).toBeLessThanOrEqual(CONTEXT_LIMITS.totalChars);
    const first = notes[0] as Record<string, unknown>;
    expect(first.ownerId).toBeUndefined();
    expect(first.authorId).toBeUndefined();
    expect(Object.values(first).every((value) => value !== null)).toBe(true);
  });
});

describe("get_context: expiry and staleness", () => {
  it("drops a dead end after it expires", async () => {
    const t = setup();
    const dead = await t.call(leadA, "post", {
      type: "dead_end",
      body: "pnpm on CI",
      conditions: "until the lockfile is migrated",
      expiresInDays: 1,
      repo: ALPHA,
    });
    const live = await t.call(leadA, "get_context", { repo: ALPHA });
    expect(ids(live.body.deadEnds)).toEqual([dead.body.postId]);
    expect(live.body.deadEnds[0]).toMatchObject({ conditions: "until the lockfile is migrated" });
    expect(live.body.deadEnds[0].expiresAt).toBeTruthy();
    t.at(new Date(Date.parse(NOW) + 2 * DAY).toISOString());
    const later = await t.call(leadA, "get_context", { repo: ALPHA });
    expect(later.body.deadEnds).toEqual([]);
  });

  it("drops claimed notes older than the stale window and stale or expired notes, keeps verified ones", async () => {
    const t = setup();
    const claimed = await t.call(leadA, "post", { type: "finding", body: "old claim", repo: ALPHA });
    const verified = await t.call(leadA, "post", { type: "finding", body: "old fact", repo: ALPHA });
    await t.call(devA, "verify_post", { postId: verified.body.postId });
    const expiring = await t.call(leadA, "post", { type: "handoff", body: "short lived", repo: ALPHA, expiresInDays: 1 });
    const staleRow = await t.call(leadA, "post", { type: "finding", body: "marked stale", repo: ALPHA });
    const row = await t.store.getPost(String(staleRow.body.postId));
    if (row) await t.store.savePost({ ...row, status: "stale" });
    const fresh = await t.call(leadA, "get_context", { repo: ALPHA });
    expect(ids(allNotes(fresh.body))).toEqual(
      expect.arrayContaining([claimed.body.postId, verified.body.postId, expiring.body.postId]),
    );
    expect(ids(allNotes(fresh.body))).not.toContain(staleRow.body.postId);
    t.at(new Date(Date.parse(NOW) + (CONTEXT_LIMITS.staleDays + 1) * DAY).toISOString());
    const later = await t.call(leadA, "get_context", { repo: ALPHA });
    expect(ids(allNotes(later.body))).toEqual([verified.body.postId]);
  });
});
