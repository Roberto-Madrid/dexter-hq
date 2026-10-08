import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { parseRoleSheet } from "../kernel/role-sheet.ts";
import { cookieHeader, emailsMatch, issueSession, readSession, sessionToken } from "./session.ts";
import { createScriptedCeo, type CeoClient } from "./scripted-ceo.ts";
import { handleChat } from "./chat.ts";
import { acceptCallback } from "./callback.ts";
import { decideApproval, type DecideApprovalResult } from "./approval.ts";
import { createPgConnectorStore } from "./connector-pg.ts";
import { createMemoryConnectorStore, type ConnectorStore } from "./connector-store.ts";
import { ownerBoardView } from "./board-notes.ts";
import { readFleetView, runFleetReportTick, type FleetDb, type FleetTickResult, type FleetView } from "./fleet-report.ts";
import { createPgFleetReports } from "./fleet-report-pg.ts";
import { createGhRepoCheck, handleVenturesHttp } from "./ventures.ts";
import {
  isSelftestQuestion,
  runDailySelftest,
  selftestChatAnswer,
  selftestHealth,
  watchdogSecretMatches,
  SELFTEST_STALE_HOURS,
  type SelftestDb,
  type SelftestHealth,
  type SelftestRecord,
  type SelftestTickResult,
} from "./selftest.ts";
import { createPgSelftestDb } from "./selftest-pg.ts";
import { resumeAll, stopAll } from "./stop.ts";
import { createDefaultConnectorDeps, loadConnectorSheetText } from "./connector.ts";
import { connectorTick } from "./pins.ts";
import { snapshot, type BoardSnapshot } from "./board.ts";
import { SHIPPED_CREWS } from "./crews.ts";
import type { HqDeps } from "./deps.ts";
import { MemoryStore } from "./memory.ts";
import type { HqStore } from "./model.ts";
import { bundledRoleSheet } from "./bundled-assets.ts";
import { AUTH_PATH, loadCodexLogin, storeCodexLogin } from "./codex-login.ts";
import { readSnapshot, writeSnapshot } from "./snapshot-db.ts";
import { createCursorCloud } from "../adapters/cursor-cloud.ts";
import { createGhRunner } from "../adapters/gh-runner.ts";
import { runCeo } from "../gateway/client.ts";
import type { ChatResult } from "../kernel/contracts.ts";
import type { PlanCard } from "../kernel/types.ts";

type Boot = { store: HqStore; deps: HqDeps; secret: string; ownerEmail: string };

export type CeoTrace = {
  stages: Record<string, number>;
  model: string | null;
  effort: string | null;
  loginHashChanged: boolean;
};

const CHAT_MAX_SECONDS = 300;
const bootKey = Symbol.for("dexter.hq.boot");
let pathBBilling = false;
let trace: CeoTrace = { stages: {}, model: null, effort: null, loginHashChanged: false };

export function ceoOutputSchema(): {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, { type?: string | string[]; items?: { type: string }; enum?: string[] }>;
} {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "text",
      "crew",
      "personas",
      "councilMode",
      "tier",
      "definitionOfDone",
      "outOfScope",
      "newScreen",
      "outwardAction",
    ],
    properties: {
      text: { type: "string" },
      crew: { type: "string", enum: ["answer", "research", "change", "custom"] },
      personas: { type: "array", items: { type: "string" } },
      councilMode: { type: "string", enum: ["off", "quick", "standard", "adversarial"] },
      tier: { type: "string", enum: ["T0", "T1", "T2", "T3"] },
      definitionOfDone: { type: "string" },
      outOfScope: { type: "string" },
      newScreen: { type: ["boolean", "null"] },
      outwardAction: { type: ["boolean", "null"] },
    },
  };
}

type RawCard = {
  text?: string;
  crew: string;
  personas?: string[];
  councilMode?: PlanCard["councilMode"];
  tier?: PlanCard["tier"];
  definitionOfDone?: string;
  outOfScope?: string;
  newScreen?: boolean | null;
  outwardAction?: boolean | null;
};

export function ceoPrompt(ask: string): string {
  return [
    "You are Dexter, the coordinator.",
    "Return only the schema.",
    "The text field is the chat reply. State the decision: what you will do, and what done means.",
    "Do not copy the owner's message. Do not answer with the same sentence.",
    `Owner: ${ask}`,
  ].join(" ");
}

export function replyEchoesAsk(reply: string, ask: string): boolean {
  return reply.trim().toLowerCase() === ask.trim().toLowerCase();
}

function rawCard(value: unknown): RawCard {
  if (!value || typeof value !== "object") throw new Error("card_missing");
  const crew = (value as { crew?: unknown }).crew;
  if (typeof crew !== "string" || !crew) throw new Error("card_missing");
  return value as RawCard;
}

function loginDigest(): string | null {
  try {
    return createHash("sha256").update(readFileSync(AUTH_PATH)).digest("hex");
  } catch {
    return null;
  }
}

function fillEnv(): void {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const index = line.indexOf("=");
      const key = line.slice(0, index).trim();
      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let value = line.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) process.env[key] = value;
    }
  } catch {
    // The host environment is enough when the file is absent.
  }
}

function pathB(sheetText: string): CeoClient {
  const sheet = parseRoleSheet(sheetText);
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async decide(text: string, onDelta?: (delta: string) => void) {
      calls += 1;
      const rawSheet = parse(sheetText) as { ceo?: { version?: string } };
      const model = rawSheet.ceo?.version;
      if (!model) throw new Error("ceo_version_missing");
      const dir = mkdtempSync(join(tmpdir(), "dexter-ceo-"));
      const output = join(dir, "out.json");
      const schema = join(dir, "card.json");
      writeFileSync(schema, JSON.stringify(ceoOutputSchema()));
      const dbUrl = process.env.SUPABASE_DB_URL ?? "";
      if (!dbUrl) throw new Error("codex_login_missing");
      const loginKind = await loadCodexLogin(dbUrl);
      if (loginKind !== "chatgpt") throw new Error(loginKind === "api_key" ? "codex_login_not_chatgpt" : "codex_login_unknown");
      const started = Date.now();
      const stages: Record<string, number> = {};
      let streamModel: string | null = null;
      let streamEffort: string | null = null;
      const beforeLogin = loginDigest();
      let runError: unknown;
      let parsed: RawCard | null = null;
      try {
        const card = await runCeo(
          {
            model,
            effort: "medium",
            prompt: ceoPrompt(text),
            schemaPath: schema,
            outputPath: output,
            codexBin: "vendor/codex/codex",
            home: "/tmp",
            disableTools: true,
          },
          (event) => {
            if (event.model) streamModel = event.model;
            if (event.effort) streamEffort = event.effort;
            if (event.text) onDelta?.(event.text);
          },
          {
            deadline: started + (CHAT_MAX_SECONDS - 10) * 1000,
            onStage(stage, ms) {
              stages[stage] = ms;
              console.log(JSON.stringify({ stage, ms }));
            },
          },
        );
        parsed = rawCard(card);
      } catch (error) {
        runError = error;
      }
      try {
        await storeCodexLogin(dbUrl);
      } catch (error) {
        if (!runError) runError = error;
      }
      stages.writeback = Date.now() - started;
      console.log(JSON.stringify({ stage: "writeback", ms: stages.writeback }));
      const afterLogin = loginDigest();
      trace = {
        stages,
        model: streamModel,
        effort: streamEffort,
        loginHashChanged: beforeLogin !== null && afterLogin !== null && beforeLogin !== afterLogin,
      };
      if (runError) throw runError;
      if (!parsed) throw new Error("card_missing");
      const reply = parsed.text?.trim() || "Plan ready.";
      if (replyEchoesAsk(reply, text)) throw new Error("reply_echo");
      const card: PlanCard = {
        crew: parsed.crew,
        personas: parsed.personas ?? ["dexter"],
        councilMode: parsed.councilMode ?? "off",
        tier: parsed.tier ?? "T1",
        definitionOfDone: parsed.definitionOfDone ?? "done",
        outOfScope: parsed.outOfScope ?? "",
        needsOwner: [],
        newScreen: parsed.newScreen ?? false,
        outwardAction: parsed.outwardAction ?? false,
        requiresDesignApproval: false,
        requiresApproval: false,
      };
      pathBBilling = true;
      return { text: reply, card, model: sheet.ceo.family, effort: sheet.ceo.reasoningEffort };
    },
  };
}

function readRoleSheet(): string {
  try {
    return readFileSync("gateway/role-sheet.yaml", "utf8");
  } catch (error) {
    const bundled = bundledRoleSheet();
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && bundled) return bundled;
    throw error;
  }
}

function current(): Boot {
  const globals = globalThis as typeof globalThis & { [bootKey]?: Boot };
  const existing = globals[bootKey];
  if (existing) return existing;
  fillEnv();
  const sheetText = readRoleSheet();
  const sheet = parseRoleSheet(sheetText);
  const mode = process.env.DEXTER_CEO ?? "path-b";
  const ceo = mode === "scripted" ? createScriptedCeo(sheet) : mode === "off" ? disabledCeo() : pathB(sheetText);
  const store = new MemoryStore();
  const cursorKey = process.env.CURSOR_API_KEY;
  const ghToken = process.env.GH_HQ_TOKEN;
  const repo = process.env.GH_WORKERS_REPO;
  const runtimes: HqDeps["runtimes"] = {};
  if (cursorKey) runtimes["cursor-cloud"] = createCursorCloud({ apiKey: cursorKey });
  if (ghToken && repo) runtimes["gh-runner"] = createGhRunner({ token: ghToken, repo });
  const next: Boot = {
    store,
    secret: process.env.DEXTER_CALLBACK_SECRET ?? "",
    ownerEmail: process.env.DEXTER_OWNER_EMAIL ?? "",
    deps: {
      ceo,
      ceoEnabled: mode !== "off",
      sheet,
      catalog: [],
      shippedCrews: SHIPPED_CREWS,
      exhaustedPools: [],
      knownHosts: ["example.com"],
      slotCap: 3,
      runtimes,
      controlReachable: true,
    },
  };
  globals[bootKey] = next;
  return next;
}

function tokenMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function disabledCeo(): CeoClient {
  return { calls: 0, async decide() { throw new Error("ceo_disabled"); } };
}

export function login(email: string, secure: boolean, now = Date.now()): { ok: true; token: string; cookie: string } | { ok: false; status: number } {
  const live = current();
  if (!live.secret || !live.ownerEmail) return { ok: false, status: 503 };
  if (!emailsMatch(email, live.ownerEmail)) return { ok: false, status: 401 };
  const token = issueSession(email.trim().toLowerCase(), live.secret, now + 7 * 24 * 60 * 60 * 1000);
  return { ok: true, token, cookie: cookieHeader(token, secure) };
}

export function emailFromCookie(header: string | null, now = Date.now()): string | null {
  const live = current();
  const token = sessionToken(header);
  if (!token || !live.secret) return null;
  return readSession(token, live.secret, now)?.email ?? null;
}

async function withStore<T>(fn: (store: HqStore) => Promise<T>): Promise<T> {
  const live = current();
  const url = process.env.SUPABASE_DB_URL;
  if (process.env.DEXTER_STORE === "memory" || !url) return fn(live.store);
  const loaded = new MemoryStore();
  try {
    const raw = await readSnapshot(url);
    if (raw && raw !== "null" && raw !== "{}") loaded.load(raw);
  } catch {
    throw new Error("hq_store_unavailable");
  }
  const result = await fn(loaded);
  await writeSnapshot(url, loaded.dump());
  return result;
}

export async function postChat(
  text: string,
  onDelta?: (delta: string) => void,
): Promise<ChatResult & { billing?: "chatgpt-plan"; trace: CeoTrace }> {
  const live = current();
  pathBBilling = false;
  trace = { stages: {}, model: null, effort: null, loginHashChanged: false };
  if (isSelftestQuestion(text)) return selftestChat(text);
  const deps = { ...live.deps, fleetReports: fleetFromEnv(), connector: live.deps.connector ?? connectorFromEnv() };
  const result = await withStore((store) => handleChat(store, deps, text, undefined, onDelta));
  const billing = pathBBilling && result.kind === "plan" ? ("chatgpt-plan" as const) : undefined;
  pathBBilling = false;
  return billing ? { ...result, billing, trace } : { ...result, trace };
}

export async function getBoard(): Promise<BoardSnapshot> {
  const live = current();
  return withStore((store) => snapshot(store, live.deps.slotCap));
}

/** GET /api/board?view=notes: owner session only; filters type, scope, repo, status (live|claimed|verified|expired|all), limit. */
export async function getBoardNotes(
  cookie: string | null,
  search: string | URLSearchParams,
  store?: ConnectorStore,
  nowIso = new Date().toISOString(),
): Promise<{ status: number; body: unknown }> {
  if (!emailFromCookie(cookie)) return { status: 401, body: { status: "refused", reason: "unauthorized" } };
  const source = store ?? connectorFromEnv() ?? createMemoryConnectorStore();
  let posts;
  try {
    posts = await source.listPosts();
  } catch {
    return { status: 503, body: { status: "error", reason: "board_unavailable" } };
  }
  return ownerBoardView(posts, new URLSearchParams(search), nowIso);
}

export async function getUsageView(
  _cookie: string | null,
  _search: string | URLSearchParams,
  _store?: ConnectorStore,
  _nowIso = new Date().toISOString(),
): Promise<{ status: number; body: unknown }> {
  return { status: 501, body: { status: "error", reason: "not_implemented" } };
}

export async function getArtifactView(_cookie: string | null, _id: string | null, _store?: ConnectorStore): Promise<{ status: number; body: unknown }> {
  return { status: 501, body: { status: "error", reason: "not_implemented" } };
}

function connectorFromEnv() {
  const url = process.env.SUPABASE_DB_URL?.trim();
  return url ? createPgConnectorStore(url) : undefined;
}

// Local runs without a database keep ventures in memory for the life of the process.
let ventureMemory: ConnectorStore | null = null;

/** Add venture / rotate token / list ventures. Owner session cookie only; see hq/ventures.ts. */
export async function venturesHttp(request: Request): Promise<Response> {
  current();
  const store = connectorFromEnv() ?? (ventureMemory ??= createMemoryConnectorStore());
  return handleVenturesHttp(request, {
    store,
    repoCheck: createGhRepoCheck({ token: process.env.GH_HQ_TOKEN?.trim() }),
    ownerFromCookie: (header) => emailFromCookie(header),
  });
}

function parseDecision(value: unknown): "approved" | "denied" | null {
  if (value === "approved" || value === "approve") return "approved";
  if (value === "denied" || value === "deny") return "denied";
  return null;
}

export async function postApproval(raw: string): Promise<DecideApprovalResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { status: "unknown", ran: false, reason: "invalid_json" };
  }
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const approvalId =
    typeof body.approvalId === "string" && body.approvalId.trim()
      ? body.approvalId.trim()
      : typeof body.id === "string" && body.id.trim()
        ? body.id.trim()
        : "";
  const decision = parseDecision(body.decision);
  if (!approvalId || !decision) return { status: "unknown", ran: false, reason: "invalid_request" };
  const store = connectorFromEnv() ?? createMemoryConnectorStore();
  return decideApproval(store, { approvalId, decision, env: process.env });
}

export async function postStop(): Promise<Awaited<ReturnType<typeof stopAll>>> {
  const live = current();
  const connector = connectorFromEnv();
  return withStore((store) => stopAll(store, { ...live.deps, connector }));
}

export async function postResume(): Promise<Awaited<ReturnType<typeof resumeAll>>> {
  const live = current();
  const connector = connectorFromEnv();
  return withStore((store) => resumeAll(store, { ...live.deps, connector }));
}

export async function postTick(
  header: string | null,
  options: { fleetReports?: FleetDb; now?: Date } = {},
): Promise<{ status: number; body?: unknown }> {
  current();
  const expected = process.env.DEXTER_TICK_SECRET ?? "";
  if (!expected || !header || !tokenMatch(header, expected)) return { status: 401 };
  // The tick no longer dispatches. In order, each failing soft: close finished connector agents so their cap
  // slots free up, write the weekly fleet report when due, then run the once-a-day model version check.
  const { reconcile, fleet, pins } = await connectorTick(
    createDefaultConnectorDeps({ store: connectorFromEnv() }),
    loadConnectorSheetText(),
    { fleet: () => fleetTick(options.fleetReports ?? fleetFromEnv(), options.now ?? new Date()) },
  );
  // Daily self-test (U6): read-only checks, once per PT day after 07:00; soft-fails like the rest.
  const selftest = await selftestTick(options.now ?? new Date());
  return { status: 200, body: { ok: true, reconcile, fleet, pins, selftest } };
}

function fleetFromEnv(): FleetDb | undefined {
  const url = process.env.SUPABASE_DB_URL?.trim();
  return url ? createPgFleetReports(url) : undefined;
}

/** Weekly fleet report on the per-minute tick. A failure is logged and never fails the tick. */
async function fleetTick(db: FleetDb | undefined, now: Date): Promise<FleetTickResult | { status: "not_configured" | "error" }> {
  if (!db) return { status: "not_configured" };
  try {
    return await runFleetReportTick({ db, now });
  } catch (error) {
    const raw = error instanceof Error ? error.message : "fleet_report_failed";
    console.error(raw.replace(/postgres(?:ql)?:\/\/\S+/gi, "[db]").slice(0, 180));
    return { status: "error" };
  }
}

/** Owner-only read for `GET /api/board?view=fleet`. Reads the stored report; never generates one. */
export async function getFleetView(
  cookie: string | null,
  week: string | null,
  db: FleetDb | undefined = fleetFromEnv(),
): Promise<{ status: number; body: FleetView | { error: string } }> {
  if (!emailFromCookie(cookie)) return { status: 401, body: { error: "unauthorized" } };
  return { status: 200, body: await readFleetView(db, week) };
}

function selftestDbFromEnv(): SelftestDb | undefined {
  const url = process.env.SUPABASE_DB_URL?.trim();
  return url ? createPgSelftestDb(url) : undefined;
}

/** Daily self-test on the per-minute tick (once per PT day after 07:00). A failure never fails the tick. */
async function selftestTick(now: Date): Promise<SelftestTickResult> {
  const db = selftestDbFromEnv();
  const connector = connectorFromEnv();
  if (!db || !connector) return { status: "not_configured" };
  try {
    return await runDailySelftest({ db, connector, env: process.env, now });
  } catch (error) {
    const raw = error instanceof Error ? error.message : "selftest_failed";
    console.error(raw.replace(/postgres(?:ql)?:\/\/\S+/gi, "[db]").slice(0, 180));
    return { status: "error" };
  }
}

async function selftestChat(text: string): Promise<ChatResult & { trace: CeoTrace }> {
  const body = await selftestChatAnswer(selftestDbFromEnv(), new Date());
  return withStore(async (store) => {
    await store.addMessage("owner", text, null);
    await store.addMessage("dexter", body, null);
    return { kind: "status" as const, text: body, modelCalls: 0, card: null, notices: [], requestId: null, asOf: store.now(), trace };
  });
}

/** Watchdog read for `GET /api/tick-now`. Its own secret (never the tick secret), compared in constant time; fails closed. */
export async function getTickHealth(
  header: string | null,
  db: SelftestDb | undefined = selftestDbFromEnv(),
): Promise<{ status: number; body?: SelftestHealth | { ok: false; reasons: string[] } }> {
  current();
  if (!watchdogSecretMatches(header, process.env.DEXTER_WATCHDOG_SECRET?.trim() ?? "")) return { status: 401 };
  if (!db) return { status: 503, body: { ok: false, reasons: ["not_configured"] } };
  const body = await selftestHealth(db, new Date());
  return { status: 200, body };
}

/** Owner-only read for `GET /api/board?view=selftest`. Reads the stored result; never runs a check. */
export async function getSelftestView(
  cookie: string | null,
  db: SelftestDb | undefined = selftestDbFromEnv(),
): Promise<{ status: number; body: { latest: SelftestRecord | null; stale: boolean } | { error: string } }> {
  if (!emailFromCookie(cookie)) return { status: 401, body: { error: "unauthorized" } };
  if (!db) return { status: 200, body: { latest: null, stale: true } };
  const latest = await db.latest();
  const stale = !latest || Date.now() - Date.parse(latest.at) >= SELFTEST_STALE_HOURS * 3_600_000;
  return { status: 200, body: { latest, stale } };
}

export async function postCallback(raw: string, signature: string | null): Promise<{ status: number; duplicate?: boolean }> {
  const live = current();
  if (!live.secret) return { status: 503 };
  return withStore(async (store) => {
    const result = await acceptCallback(store, live.secret, raw, signature);
    return { status: result.status, duplicate: result.duplicate };
  });
}
