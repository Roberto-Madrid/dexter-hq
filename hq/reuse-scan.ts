// Token police part B: the reuse scan from agent-brake's `reuse.scan`. When one approach (a slug bots attach to a
// note or a Checker run, like agent-brake's `operation`) succeeds 3 times across 2+ distinct agents, HQ posts one
// suggestion to Dexter to turn it into a skill. It is a recommendation only: nothing is drafted, written or installed.
// Unlike agent-brake, successes are pooled across ventures: the suggestion goes to the CEO, who already reads every scope.
import type { ConnectorPost, ConnectorStore } from "./connector-store.ts";
import { SKILL_SUGGESTION_KIND, stableId } from "./board-notes.ts";
import { SKILL_MAX_WORDS } from "./token-police.ts";

export { SKILL_SUGGESTION_KIND };
/** agent-brake `scan(minimum=3)`, which also requires two distinct successful agents. */
export const REUSE_MIN_SUCCESSES = 3;
export const REUSE_MIN_AGENTS = 2;
export const SKILL_SUGGESTION_ACTION = "skill_suggestion";
const SUCCESS_TYPES = new Set(["finding", "shortcut"]);

export function skillSuggestionId(ownerId: string, approach: string): string {
  return stableId(`skill-suggestion:${ownerId}:${approach}`);
}

export type ReuseScanResult = {
  approach: string;
  successes: number;
  agents: number;
  /** Set only when this scan wrote the suggestion. */
  postId: string | null;
  existing: boolean;
};

type Success = { key: string; agent: string; repo: string | null; source: "note" | "check" };

/**
 * An agent is a launched Cursor agent the bot owns (validated against `connector_agents`), else the bot itself.
 * A made-up agent id credits the bot, so one bot cannot look like many.
 */
async function agentKey(store: ConnectorStore, botId: string, agentRef: string | null, cache: Map<string, Promise<string | null>>): Promise<string> {
  if (agentRef) {
    let found = cache.get(agentRef);
    if (!found) {
      found = store.getAgent(agentRef).then((agent) => (agent ? `${agent.botId}|${agent.id}` : null));
      cache.set(agentRef, found);
    }
    const hit = await found;
    if (hit && hit.startsWith(`${botId}|`)) return `agent:${hit.slice(botId.length + 1)}`;
  }
  return `bot:${botId}`;
}

/** The agent row id an agentId arg names, when it belongs to this bot; else null. */
export async function creditedAgentId(store: ConnectorStore, botId: string, agentRef: string | null): Promise<string | null> {
  if (!agentRef) return null;
  const agent = await store.getAgent(agentRef);
  return agent && agent.botId === botId ? agent.id : null;
}

async function successes(store: ConnectorStore, ownerId: string, approach: string): Promise<Success[]> {
  const cache = new Map<string, Promise<string | null>>();
  const out: Success[] = [];
  const notes = (await store.listPosts()).filter(
    (post: ConnectorPost) => post.ownerId === ownerId && post.approach === approach && SUCCESS_TYPES.has(post.type) && post.status === "verified",
  );
  for (const post of notes) {
    out.push({ key: `note:${post.id}`, agent: await agentKey(store, post.authorId ?? post.author, post.agentId ?? null, cache), repo: post.repo, source: "note" });
  }
  // dexter-shortcut: reads the newest 5000 request_checks events; upgrade path: an (action, result->>'approach') index or a reuse table.
  const seen = new Set<string>();
  for (const event of await store.listEventsByAction("request_checks", { limit: 5000 })) {
    const r = event.result;
    if (event.ownerId !== ownerId || r?.status !== "ready" || r.approach !== approach || typeof r.nonce !== "string") continue;
    if (seen.has(r.nonce)) continue;
    seen.add(r.nonce);
    const bot = typeof r.botId === "string" ? r.botId : event.actor;
    const credited = typeof r.creditedAgentId === "string" ? `agent:${r.creditedAgentId}` : `bot:${bot}`;
    out.push({ key: `check:${r.nonce}`, agent: credited, repo: typeof r.repo === "string" ? r.repo : null, source: "check" });
  }
  return out;
}

export function skillSuggestionBody(input: { approach: string; successes: number; agents: number; notes: number; checks: number; repos: string[] }): string {
  const where = input.repos.length > 0 ? `; repos ${input.repos.slice(0, 5).join(", ")}` : "";
  return (
    `SKILL SUGGESTION: approach "${input.approach}" had ${input.successes} successes across ${input.agents} agents ` +
    `(${input.notes} verified notes, ${input.checks} Checker passes${where}). ` +
    `Turn it into a skill if it is worth keeping (at most ${SKILL_MAX_WORDS} words, reviewed like any change). Nothing was written; you decide.`
  );
}

/** Scan one approach; at the threshold, write the CEO-only suggestion once (stable id) plus one `skill_suggestion` event. */
export async function reuseScan(store: ConnectorStore, ownerId: string, approach: string, nowIso: string): Promise<ReuseScanResult> {
  const found = await successes(store, ownerId, approach);
  const agents = new Set(found.map((item) => item.agent)).size;
  const result: ReuseScanResult = { approach, successes: found.length, agents, postId: null, existing: false };
  if (found.length < REUSE_MIN_SUCCESSES || agents < REUSE_MIN_AGENTS) return result;
  const id = skillSuggestionId(ownerId, approach);
  if (await store.getPost(id)) return { ...result, existing: true };
  const notes = found.filter((item) => item.source === "note");
  const checks = found.filter((item) => item.source === "check");
  const repos = [...new Set(found.map((item) => item.repo).filter((repo): repo is string => Boolean(repo)))].sort();
  await store.savePost({
    id,
    ownerId,
    type: "alert",
    author: "hq",
    body: skillSuggestionBody({ approach, successes: found.length, agents, notes: notes.length, checks: checks.length, repos }),
    repo: null,
    verified: false,
    authorId: null,
    status: null,
    verifiedBy: null,
    scope: "shared",
    kind: SKILL_SUGGESTION_KIND,
    approach,
    createdAt: nowIso,
  });
  await store.appendEvent({
    ownerId,
    actor: "hq",
    action: SKILL_SUGGESTION_ACTION,
    target: approach,
    result: { status: "suggested", postId: id, approach, successes: found.length, agents, evidence: found.slice(0, 20).map((item) => item.key), repos },
    at: nowIso,
  });
  return { ...result, postId: id };
}
