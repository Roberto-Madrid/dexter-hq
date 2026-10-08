import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createMemoryConnectorStore, type ConnectorPost, type ConnectorStore } from "../../hq/connector-store.ts";
import { SHIPPED_CREWS, loadCrews } from "../../hq/crews.ts";
import {
  JOB_SCAN_KIND,
  createMemoryJobScans,
  jobScanId,
  loadJobScanPrefs,
  readJobScanView,
  runJobScanTick,
} from "../../hq/job-scan.ts";
import { loadPersonas, personaIdForRole } from "../../hq/personas.ts";
import { getJobScanView, login, postTick } from "../../hq/server.ts";
import {
  JOB_LEAD_PREFIX,
  buildJobScanBrief,
  fitScore,
  parseJobLead,
  renderJobScanBrief,
  type JobScanPrefs,
} from "../../kernel/job-scan.ts";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OWNER_EMAIL = "owner@example.com";
// W40 in America/Tijuana: Mon Sep 28 00:00 PT to Mon Oct 5 00:00 PT. Due from Mon Oct 5 07:00 PT (14:00Z).
const W40 = { key: "2026-W40", start: "2026-09-28T07:00:00.000Z", end: "2026-10-05T07:00:00.000Z" };
const DUE = new Date("2026-10-05T14:00:00.000Z");
const PREFS: JobScanPrefs = { include: ["ai", "llm", "agents"], exclude: ["unpaid", "internship"], remoteOnly: true, minScore: 20, top: 5 };

beforeAll(() => {
  process.env.SUPABASE_DB_URL = "";
  process.env.DEXTER_STORE = "memory";
  process.env.DEXTER_CEO = "off";
  process.env.DEXTER_CALLBACK_SECRET = "unit-test-session-secret-0123456789";
  process.env.DEXTER_OWNER_EMAIL = OWNER_EMAIL;
  process.env.DEXTER_TICK_SECRET = "unit-test-tick-secret";
});

function lead(id: string, lines: string[], extra: Partial<ConnectorPost> = {}): ConnectorPost {
  return {
    id,
    ownerId: OWNER,
    type: "finding",
    author: "scout",
    body: lines.join("\n"),
    repo: null,
    verified: false,
    link: `https://jobs.example.test/${id}`,
    createdAt: "2026-10-01T18:00:00.000Z",
    ...extra,
  };
}

const LEADS: ConnectorPost[] = [
  lead("strong", [`${JOB_LEAD_PREFIX} Senior AI Engineer at Acme`, "location: Remote (US)", "remote: yes", "tags: llm, agents, typescript", "posted: 2026-10-01"]),
  lead("ok", [`${JOB_LEAD_PREFIX} Backend Engineer at Beta`, "remote: yes", "tags: ai, go", "posted: 2026-09-20"]),
  lead("onsite", [`${JOB_LEAD_PREFIX} AI Researcher at Gamma`, "location: Berlin", "remote: no", "tags: llm"]),
  lead("unpaid", [`${JOB_LEAD_PREFIX} AI Internship at Delta`, "remote: yes", "tags: ai"]),
  lead("weak", [`${JOB_LEAD_PREFIX} Office Manager at Epsilon`, "remote: yes"]),
  lead("dupe", [`${JOB_LEAD_PREFIX} Senior AI Engineer at Acme`, "remote: yes", "tags: llm"], { link: "https://jobs.example.test/strong" }),
  // Not leads: another finding, and a lead posted outside the week.
  lead("finding", ["The barber API rate-limits at 10 rps."]),
  lead("late", [`${JOB_LEAD_PREFIX} LLM Engineer at Zeta`, "remote: yes", "tags: llm"], { createdAt: "2026-10-06T18:00:00.000Z" }),
];

async function seeded(posts = LEADS): Promise<ConnectorStore> {
  const store = createMemoryConnectorStore();
  for (const post of posts) await store.savePost(post);
  return store;
}

describe("job lead parsing and the fit score", () => {
  it("parses the lead format and ignores other notes", () => {
    expect(parseJobLead(LEADS[0]!)).toMatchObject({
      postId: "strong",
      title: "Senior AI Engineer",
      company: "Acme",
      location: "Remote (US)",
      remote: true,
      tags: ["llm", "agents", "typescript"],
      link: "https://jobs.example.test/strong",
      postedAt: "2026-10-01",
    });
    expect(parseJobLead(LEADS[6]!)).toBeNull();
  });

  it("scores deterministically and explains why", () => {
    const now = new Date("2026-10-05T14:00:00.000Z");
    const strong = fitScore(parseJobLead(LEADS[0]!)!, PREFS, now);
    const ok = fitScore(parseJobLead(LEADS[1]!)!, PREFS, now);
    expect(strong.score).toBeGreaterThan(ok.score);
    expect(strong).toEqual(fitScore(parseJobLead(LEADS[0]!)!, PREFS, now));
    expect(strong.reasons.join(" ")).toContain("remote");
    expect(strong.score).toBeLessThanOrEqual(100);
  });
});

describe("ranked brief", () => {
  it("filters, dedupes, ranks, and promises no outward action", () => {
    const brief = buildJobScanBrief({ week: W40, generatedAt: DUE.toISOString(), posts: LEADS, prefs: PREFS });
    expect(brief.week).toBe("2026-W40");
    expect(brief.collected).toBe(6);
    expect(brief.ranked.map((row) => row.postId)).toEqual(["strong", "ok"]);
    expect(brief.ranked.map((row) => row.rank)).toEqual([1, 2]);
    expect(brief.dropped).toEqual({ duplicate: 1, excluded: 1, not_remote: 1, below_min_score: 1 });
    expect(brief.outwardActions).toEqual([]);
    const text = renderJobScanBrief(brief);
    expect(text.split("\n")[0]).toBe("Job scan 2026-W40: 2 of 6 leads fit.");
    expect(text).toContain("1. Senior AI Engineer at Acme");
    expect(text).toContain("https://jobs.example.test/strong");
    expect(text).toContain("Nothing was applied to and nobody was contacted.");
  });

  it("caps the list at top", () => {
    const brief = buildJobScanBrief({ week: W40, generatedAt: DUE.toISOString(), posts: LEADS, prefs: { ...PREFS, top: 1 } });
    expect(brief.ranked.map((row) => row.postId)).toEqual(["strong"]);
  });
});

describe("weekly schedule", () => {
  it("does nothing before Monday 07:00 PT", async () => {
    const store = await seeded();
    const db = createMemoryJobScans(store);
    expect(await runJobScanTick({ db, now: new Date("2026-10-05T13:59:00.000Z"), prefs: PREFS })).toEqual({ status: "not_due" });
    expect(await store.listPosts()).toHaveLength(LEADS.length);
  });

  it("fires once per week, however many ticks run or race, and again next week", async () => {
    const store = await seeded();
    const db = createMemoryJobScans(store);
    const first = await runJobScanTick({ db, now: DUE, prefs: PREFS, ownerId: OWNER });
    expect(first).toEqual({ status: "written", week: "2026-W40", postId: jobScanId("2026-W40"), ranked: 2 });
    const raced = await Promise.all([1, 2, 3].map((minute) => runJobScanTick({ db, now: new Date(DUE.getTime() + minute * 60_000), prefs: PREFS })));
    expect(raced.map((item) => item.status)).toEqual(["exists", "exists", "exists"]);
    const later = await runJobScanTick({ db, now: new Date("2026-10-11T23:00:00.000Z"), prefs: PREFS });
    expect(later).toMatchObject({ status: "exists", week: "2026-W40" });
    const next = await runJobScanTick({ db, now: new Date("2026-10-12T14:05:00.000Z"), prefs: PREFS });
    expect(next).toMatchObject({ status: "written", week: "2026-W41", ranked: 1 });
    const briefs = (await store.listPosts()).filter((post) => post.kind === JOB_SCAN_KIND);
    expect(briefs.map((post) => post.id).sort()).toEqual([jobScanId("2026-W40"), jobScanId("2026-W41")].sort());
    expect((await store.listEvents()).filter((event) => event.action === "job_scan")).toHaveLength(2);
  });

  it("writes only its brief: no requests, approvals, agents, or other posts", async () => {
    const store = await seeded();
    const db = createMemoryJobScans(store);
    await runJobScanTick({ db, now: DUE, prefs: PREFS, ownerId: OWNER });
    const created = (await store.listPosts()).filter((post) => !LEADS.some((item) => item.id === post.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: "alert", author: "hq", kind: JOB_SCAN_KIND, ownerId: OWNER, repo: null });
    expect(await store.listRequests()).toEqual([]);
    expect(await store.listApprovals()).toEqual([]);
    expect(await store.listAgents()).toEqual([]);
    expect((await store.listEvents()).map((event) => event.action)).toEqual(["job_scan"]);
  });

  it("reads the brief back for the owner, and says so when there is none", async () => {
    const store = await seeded();
    const db = createMemoryJobScans(store);
    expect((await readJobScanView(db, null)).text).toContain("No job scan yet");
    await runJobScanTick({ db, now: DUE, prefs: PREFS });
    const view = await readJobScanView(db, null);
    expect(view).toMatchObject({ week: "2026-W40", brief: { ranked: [{ postId: "strong" }, { postId: "ok" }] } });
    expect((await readJobScanView(db, "bad")).text).toContain("Unknown week");
  });
});

describe("job scan on the per-minute tick", () => {
  it("runs from postTick once per week and stays fail-soft", async () => {
    const store = await seeded();
    const db = createMemoryJobScans(store);
    const first = await postTick("unit-test-tick-secret", { jobScans: db, now: DUE });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ jobScan: { status: "written", week: "2026-W40" } });
    const second = await postTick("unit-test-tick-secret", { jobScans: db, now: DUE });
    expect(second.body).toMatchObject({ jobScan: { status: "exists", week: "2026-W40" } });
    const broken = { ...db, async getBrief(): Promise<never> { throw new Error("postgres://user:pw@db/x down"); } };
    const failed = await postTick("unit-test-tick-secret", { jobScans: broken, now: DUE });
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ ok: true, jobScan: { status: "error" } });
    const none = await postTick("unit-test-tick-secret", { now: DUE });
    expect(none.body).toMatchObject({ jobScan: { status: "not_configured" } });
  });

  it("serves GET /api/board?view=jobs to the owner only", async () => {
    const store = await seeded();
    const db = createMemoryJobScans(store);
    await runJobScanTick({ db, now: DUE, prefs: PREFS });
    expect((await getJobScanView(null, null, db)).status).toBe(401);
    const session = login(OWNER_EMAIL, false);
    if (!session.ok) throw new Error("login failed");
    const view = await getJobScanView(session.cookie.split(";")[0] ?? "", null, db);
    expect(view).toMatchObject({ status: 200, body: { week: "2026-W40" } });
  });
});

describe("job-scan crew, career persona, and preferences", () => {
  it("ships the crew as the catalog says: Career brief, Council off, tier T1", () => {
    const raw = parse(readFileSync("crews/job-scan.yaml", "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({ name: "job-scan", tier: "T1", council: "off", personas: ["career"] });
    const crew = loadCrews().get("job-scan");
    expect(crew?.tasks).toEqual([{ persona: "career", role: "career", artifact: "note", dependsOn: [] }]);
    expect(parseRoleSheet(readFileSync("gateway/role-sheet.yaml", "utf8")).roles.career).toBeDefined();
    expect(SHIPPED_CREWS as readonly string[]).toContain("job-scan");
  });

  it("the career persona collects leads in the brief's format and never applies or contacts anyone", () => {
    expect(personaIdForRole("career")).toBe("career");
    const text = loadPersonas().get("career") ?? "";
    expect(text).toContain(JOB_LEAD_PREFIX);
    expect(text).toMatch(/never apply/i);
    expect(text).toMatch(/approval card/i);
  });

  it("loads preferences from the crew file (bundled with the app)", () => {
    const prefs = loadJobScanPrefs();
    expect(prefs.include.length).toBeGreaterThan(0);
    expect(prefs.top).toBeGreaterThan(0);
  });
});
