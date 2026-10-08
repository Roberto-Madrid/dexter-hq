// Stage 3 unit 3: the owner adds a venture (a lead bot with one repo and a token shown once) and rotates
// its token. Owner session only; a bot token never reaches these handlers. No new table: a venture is a
// `bots` row (kind lead) + one hashed `bot_tokens` row + an `add_venture` event.
import { randomBytes, randomUUID } from "node:crypto";
import { redact } from "../kernel/redact.ts";
import { STUB_OWNER_ID, hashBotToken } from "./connector.ts";
import {
  heartbeatStatus,
  ventureName,
  type BotStatus,
  type ConnectorStore,
  type RosterRow,
  type VentureDecision,
  type VentureRefusal,
} from "./connector-store.ts";

export { botRoster, heartbeatStatus, LIVE_WINDOW_SECONDS, type RosterEntry } from "./connector-store.ts";

/** The Stage 2 barber-lead set (`/workspace/stage2-tokens/README.md`). Leads never get `assign` or `open_request`. */
export const LEAD_SCOPES = [
  "whoami",
  "update_request",
  "launch_agent",
  "agent_status",
  "followup_agent",
  "cancel_agent",
  "request_checks",
  "request_council",
  "request_approval",
  "approval_status",
  "post",
  "verify_post",
  "get_context",
  "heartbeat",
] as const;

export const REPO_CHECK_TIMEOUT_MS = 5_000;
const NAME_MAX = 60;
const BRIEF_MAX = 2_000;
const KEY_MAX = 200;
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const LEAD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type RepoCheckResult = "reachable" | "not_reachable" | "unavailable";
export type RepoCheck = (repo: string) => Promise<RepoCheckResult>;

export type VenturesDeps = {
  store: ConnectorStore;
  repoCheck: RepoCheck;
  /** The dashboard's owner session check (`emailFromCookie`). Bearer headers are never read. */
  ownerFromCookie: (cookieHeader: string | null) => string | null;
  now?: () => Date;
  mintToken?: () => string;
};

export type VentureView = {
  botId: string;
  name: string;
  repo: string | null;
  leadName: string;
  brief: string | null;
  status: BotStatus;
  heartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  tokenIssuedAt: string | null;
};

/** 32 random bytes, base64url: `dxt_` + 43 characters. Only sha256 of it is stored. */
export function mintVentureToken(): string {
  return `dxt_${randomBytes(32).toString("base64url")}`;
}

/**
 * GET https://api.github.com/repos/{owner}/{name} with the HQ GitHub token (the Checker's credential).
 * 200 → reachable; 404 → not reachable (missing, or the token cannot see it); anything else, a timeout,
 * or no token → unavailable. Callers refuse on both failures (fail closed).
 */
export function createGhRepoCheck(options: {
  token: string | undefined;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}): RepoCheck {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? "https://api.github.com";
  return async (repo) => {
    if (!options.token) return "unavailable";
    try {
      const response = await fetchImpl(`${apiBase}/repos/${repo}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${options.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? REPO_CHECK_TIMEOUT_MS),
      });
      if (response.status === 200) return "reachable";
      if (response.status === 404) return "not_reachable";
      return "unavailable";
    } catch {
      return "unavailable";
    }
  };
}

function ventureView(row: RosterRow, now: Date): VentureView {
  const status = heartbeatStatus({ heartbeatAt: row.bot.heartbeatAt, tokenIssuedAt: row.tokenIssuedAt }, now);
  return {
    botId: row.bot.id,
    name: ventureName(row),
    repo: row.venture?.repo ?? row.bot.repos[0] ?? null,
    leadName: row.bot.name,
    brief: row.venture?.brief ?? null,
    status: status.status,
    heartbeatAt: status.heartbeatAgeSeconds === null ? null : row.bot.heartbeatAt,
    heartbeatAgeSeconds: status.heartbeatAgeSeconds,
    tokenIssuedAt: row.tokenIssuedAt,
  };
}

type AddInput = { name: string; repo: string; leadName: string; brief: string | null; idempotencyKey: string | null };
type Invalid = { field: string };

function str(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" ? value.trim() : null;
}

function parseAdd(body: Record<string, unknown>): AddInput | Invalid {
  const name = str(body, "name");
  if (!name || name.length > NAME_MAX || CONTROL_CHARS.test(name)) return { field: "name" };
  const repo = str(body, "repo");
  if (!repo || !REPO_PATTERN.test(repo)) return { field: "repo" };
  const leadName = str(body, "leadName");
  if (!leadName || !LEAD_PATTERN.test(leadName)) return { field: "leadName" };
  const rawBrief = body.brief;
  if (rawBrief !== undefined && rawBrief !== null && typeof rawBrief !== "string") return { field: "brief" };
  const brief = typeof rawBrief === "string" ? rawBrief.trim() : "";
  if (brief.length > BRIEF_MAX) return { field: "brief" };
  const rawKey = body.idempotencyKey;
  if (rawKey !== undefined && rawKey !== null && (typeof rawKey !== "string" || rawKey.length > KEY_MAX)) {
    return { field: "idempotencyKey" };
  }
  const key = typeof rawKey === "string" && rawKey.trim() ? rawKey.trim() : null;
  // The brief is stored in an append-only event, so secret-shaped text is redacted before it lands.
  return { name, repo, leadName, brief: brief ? redact(brief) : null, idempotencyKey: key };
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function decideCreate(input: AddInput, fallbackOwner: string) {
  return (roster: RosterRow[], stopped: boolean): VentureDecision => {
    const refuse = (refusal: VentureRefusal): VentureDecision => ({ ok: false, refusal });
    if (stopped) return refuse({ reason: "stopped", field: null });
    const leads = roster.filter((row) => row.bot.kind === "lead");
    if (input.idempotencyKey) {
      const replay = leads.find(
        (row) => row.venture?.idempotencyKey === input.idempotencyKey && same(ventureName(row), input.name),
      );
      if (replay) return refuse({ reason: "replay", field: null, botId: replay.bot.id });
    }
    if (leads.some((row) => same(ventureName(row), input.name))) return refuse({ reason: "name_taken", field: "name" });
    if (leads.some((row) => row.bot.repos.some((repo) => same(repo, input.repo)))) {
      return refuse({ reason: "repo_taken", field: "repo" });
    }
    if (roster.some((row) => same(row.bot.name, input.leadName))) {
      return refuse({ reason: "lead_name_taken", field: "leadName" });
    }
    // dexter-shortcut: single-owner deployment, so the new lead takes the owner id of the existing CEO bot;
    // upgrade path: map the owner session email to an owner id once HQ has more than one owner.
    const owner = roster.find((row) => row.bot.kind === "ceo")?.bot.ownerId ?? roster[0]?.bot.ownerId ?? fallbackOwner;
    return { ok: true, ownerId: owner };
  };
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function refused(status: number, reason: string, field: string | null = null): Response {
  return json(status, { status: "refused", reason, field });
}

const REFUSAL_STATUS: Record<string, number> = { stopped: 409, name_taken: 409, repo_taken: 409, lead_name_taken: 409 };

async function findVenture(store: ConnectorStore, botId: string, now: Date): Promise<VentureView | null> {
  const row = (await store.listRoster()).find((item) => item.bot.id === botId && item.bot.kind === "lead");
  return row ? ventureView(row, now) : null;
}

async function addVenture(deps: VenturesDeps, body: Record<string, unknown>, now: Date): Promise<Response> {
  const input = parseAdd(body);
  if ("field" in input) return refused(400, "invalid_input", input.field);
  // Cheap refusals first, so STOP ALL and duplicates never cost a GitHub call.
  if (await deps.store.stopped()) return refused(409, "stopped");
  const decide = decideCreate(input, STUB_OWNER_ID);
  const early = decide(await deps.store.listRoster(), false);
  if (!early.ok) return refusalResponse(deps, early.refusal, now);

  let reach: RepoCheckResult;
  try {
    reach = await deps.repoCheck(input.repo);
  } catch {
    reach = "unavailable";
  }
  if (reach === "not_reachable") return refused(422, "repo_not_reachable", "repo");
  if (reach !== "reachable") return refused(503, "repo_check_unavailable", "repo");

  const token = (deps.mintToken ?? mintVentureToken)();
  const at = now.toISOString();
  const created = await deps.store.createVenture({
    bot: {
      id: randomUUID(),
      name: input.leadName,
      kind: "lead",
      repos: [input.repo],
      tools: [...LEAD_SCOPES],
      currentTask: null,
      heartbeatAt: null,
    },
    tokenHash: hashBotToken(token),
    scopes: [...LEAD_SCOPES],
    at,
    actor: "owner",
    meta: { name: input.name, repo: input.repo, brief: input.brief, idempotencyKey: input.idempotencyKey },
    decide,
  });
  if (!created.ok) return refusalResponse(deps, created.refusal, now);
  const venture = await findVenture(deps.store, created.bot.id, now);
  return json(201, { status: "created", venture, token, tokenShownOnce: true });
}

async function refusalResponse(deps: VenturesDeps, refusal: VentureRefusal, now: Date): Promise<Response> {
  if (refusal.reason === "replay") {
    // Same form submission again: no second lead and no second token. The token cannot be shown again
    // (only its hash exists); the owner rotates to get a fresh one.
    return json(200, { status: "already_created", venture: await findVenture(deps.store, refusal.botId, now), token: null });
  }
  return refused(REFUSAL_STATUS[refusal.reason] ?? 409, refusal.reason, refusal.field);
}

async function rotate(deps: VenturesDeps, body: Record<string, unknown>, now: Date): Promise<Response> {
  const botId = str(body, "botId");
  if (!botId) return refused(400, "invalid_input", "botId");
  const token = (deps.mintToken ?? mintVentureToken)();
  // dexter-shortcut: a retried rotate mints again and revokes the token the first try returned (only a hash
  // is kept, so a lost response cannot be replayed); upgrade path: none needed, the latest token wins.
  const rotated = await deps.store.rotateToken({
    botId,
    tokenHash: hashBotToken(token),
    at: now.toISOString(),
    actor: "owner",
    fallbackScopes: [...LEAD_SCOPES],
  });
  if (!rotated.ok) return refused(404, "unknown_venture", "botId");
  const venture = await findVenture(deps.store, rotated.bot.id, now);
  return json(200, { status: "rotated", venture, token, tokenShownOnce: true });
}

async function list(deps: VenturesDeps, now: Date): Promise<Response> {
  const [roster, stopped] = await Promise.all([deps.store.listRoster(), deps.store.stopped()]);
  const ventures = roster.filter((row) => row.bot.kind === "lead").map((row) => ventureView(row, now));
  return json(200, { asOf: now.toISOString(), stopped, ventures });
}

/** `GET` lists ventures; `POST {action:"add_venture"|"rotate_token", ...}` changes them. Owner session only. */
export async function handleVenturesHttp(request: Request, deps: VenturesDeps): Promise<Response> {
  if (!deps.ownerFromCookie(request.headers.get("cookie"))) return refused(401, "unauthorized");
  const now = (deps.now ?? (() => new Date()))();
  try {
    if (request.method === "GET") return await list(deps, now);
    if (request.method !== "POST") return refused(405, "method_not_allowed");
    let body: Record<string, unknown>;
    try {
      const parsed = (await request.json()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return refused(400, "invalid_input", "body");
      body = parsed as Record<string, unknown>;
    } catch {
      return refused(400, "invalid_input", "body");
    }
    if (body.action === "add_venture") return await addVenture(deps, body, now);
    if (body.action === "rotate_token") return await rotate(deps, body, now);
    return refused(400, "invalid_input", "action");
  } catch {
    return refused(503, "store_unavailable");
  }
}
