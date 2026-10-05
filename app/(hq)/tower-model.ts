import { SANDBOX_SLOT_CAP } from "../../kernel/police.ts";
import type {
  ConnectorAgent,
  ConnectorApproval,
  ConnectorBot,
  ConnectorEvent,
  ConnectorRequest,
} from "../../hq/connector-store.ts";
import {
  DIM,
  EXAMPLE_LABEL,
  FORMING,
  INK,
  LIVE,
  SWARM_STATUS,
  desktopGraph,
  exampleBots,
  exampleCeo,
  exampleCounts,
  exampleNeeds,
  exampleRequests,
  phoneGraph,
  requestGraph,
  type GraphModel,
  type RequestStatus,
} from "./example-fixture.ts";

export type DataSource = "live" | "example";

export type TowerCount = { label: string; value: string; source: DataSource };

export type TowerRequest = {
  id: string;
  title: string;
  status: RequestStatus;
  owner: string;
  body: string | null;
};

export type TowerNeed = { id: string; text: string };

export type TowerBot = {
  name: string;
  state: "live" | "waiting" | "idle" | "stale";
  task: string | null;
  repos: string[];
};

export type TowerPanel<T> = { source: DataSource; items: T[] };

export type SwarmNode = {
  id: string;
  label: string;
  parentId: string | null;
  tone: "live" | "forming" | "dim";
};

export type TowerSnapshot = {
  stopped: boolean;
  counts: TowerCount[];
  requests: TowerPanel<TowerRequest>;
  needs: TowerPanel<TowerNeed>;
  bots: TowerPanel<TowerBot>;
  ceo: { source: DataSource; items: string[] };
  swarm: {
    source: DataSource;
    desktop: GraphModel;
    phone: GraphModel;
    request: GraphModel;
    nodes: SwarmNode[];
  };
};

export const STALE_MS = 5 * 60 * 1000;
const CEO_ACTIONS = new Set(["open_request", "assign", "request_council", "update_request"]);
const ACTIVE_AGENT = new Set(["launched", "running", "starting", "CREATING", "RUNNING", "queued"]);

export type ConnectorLive = {
  stopped?: boolean;
  bots?: ConnectorBot[];
  requests?: ConnectorRequest[];
  approvals?: ConnectorApproval[];
  events?: ConnectorEvent[];
  agents?: ConnectorAgent[];
};

export type CursorLive = {
  runs: { id: string; name?: string; status?: string }[];
  usageText: string | null;
};

export type TowerInputs = {
  nowMs: number;
  connector?: ConnectorLive | null;
  cursor?: CursorLive | null;
  agentCap?: number;
};

function toneFill(tone: SwarmNode["tone"]): string {
  if (tone === "live") return LIVE;
  if (tone === "forming") return FORMING;
  return DIM;
}

export function graphFromSwarm(
  nodes: SwarmNode[],
  size: { width: number; height: number },
  status: string,
): GraphModel {
  const cx = size.width / 2;
  const cy = size.height / 2;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, SwarmNode[]>();
  const roots: SwarmNode[] = [];
  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId)) {
      roots.push(node);
      continue;
    }
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const placed = new Map<string, { x: number; y: number }>();
  if (roots.length === 0) {
    return { width: size.width, height: size.height, status, lines: [], nodes: [], labels: [] };
  }
  const root = roots[0];
  placed.set(root.id, { x: cx, y: cy });
  const radius = Math.min(size.width, size.height) * 0.22;
  const first = children.get(root.id) ?? roots.slice(1);
  first.forEach((child, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(first.length, 1);
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    placed.set(child.id, { x, y });
    const grand = children.get(child.id) ?? [];
    grand.forEach((item, grandIndex) => {
      const spread = (grandIndex - (grand.length - 1) / 2) * 0.28;
      placed.set(item.id, {
        x: cx + Math.cos(angle + spread) * radius * 1.7,
        y: cy + Math.sin(angle + spread) * radius * 1.7,
      });
    });
  });
  for (const node of nodes) {
    if (placed.has(node.id)) continue;
    placed.set(node.id, { x: cx, y: cy + radius });
  }
  const lines = nodes.flatMap((node) => {
    if (!node.parentId) return [];
    const from = placed.get(node.parentId);
    const to = placed.get(node.id);
    if (!from || !to) return [];
    return [{ x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: toneFill(node.tone) }];
  });
  return {
    width: size.width,
    height: size.height,
    status,
    lines,
    nodes: nodes.map((node) => {
      const point = placed.get(node.id) ?? { x: cx, y: cy };
      return { cx: point.x, cy: point.y, r: node.parentId ? 3.5 : 4.5, fill: toneFill(node.tone) };
    }),
    labels: nodes.map((node) => {
      const point = placed.get(node.id) ?? { x: cx, y: cy };
      return {
        left: point.x + 12,
        top: point.y - 6,
        width: Math.min(140, size.width - point.x - 16),
        align: "left" as const,
        color: toneFill(node.tone) === DIM ? DIM : node.parentId ? toneFill(node.tone) : INK,
        weight: node.parentId ? (400 as const) : (500 as const),
        lines: [node.label],
      };
    }),
  };
}

function requestStatus(status: string): RequestStatus {
  if (status === "needs_you" || status === "needs") return "needs";
  if (status === "running" || status === "verifying" || status === "active") return "active";
  if (status === "done" || status === "ready_for_review" || status === "failed" || status === "cancelled") return "done";
  return "queued";
}

function botState(bot: ConnectorBot, nowMs: number): TowerBot["state"] {
  if (!bot.heartbeatAt) return bot.currentTask ? "waiting" : "idle";
  const age = nowMs - Date.parse(bot.heartbeatAt);
  if (Number.isNaN(age) || age > STALE_MS) return "stale";
  return "live";
}

function botTone(state: TowerBot["state"]): SwarmNode["tone"] {
  if (state === "live") return "live";
  if (state === "idle") return "dim";
  return "forming";
}

function shortId(id: string): string {
  const tail = id.split(":").at(-1) ?? id;
  return tail.length <= 10 ? tail : tail.slice(0, 8);
}

function ceoLine(event: ConnectorEvent): string {
  const result = event.result ?? {};
  if (event.action === "request_council") {
    const verdict = typeof result.result === "string" ? result.result : typeof result.status === "string" ? result.status : "";
    return verdict ? `${event.actor}: Council ${verdict}` : `${event.actor} asked the Council`;
  }
  if (event.action === "open_request") return `${event.actor} opened a request`;
  if (event.action === "assign") return `${event.actor} assigned ${event.target}`;
  if (event.action === "update_request") return `${event.actor} updated ${event.target}`;
  return `${event.actor} ${event.action}`;
}

function weekCouncil(events: ConnectorEvent[], nowMs: number): number {
  const start = nowMs - 7 * 24 * 60 * 60 * 1000;
  return events.filter((event) => event.action === "request_council" && Date.parse(event.at) >= start).length;
}

export function exampleTowerSnapshot(): TowerSnapshot {
  return {
    stopped: false,
    counts: exampleCounts.map((item) => ({ ...item, source: "example" })),
    requests: { source: "example", items: exampleRequests.map((item) => ({ ...item })) },
    needs: {
      source: "example",
      items: exampleNeeds.map((text, index) => ({ id: `example-need-${index}`, text })),
    },
    bots: {
      source: "example",
      items: exampleBots.map((bot) => ({ name: bot.name, state: bot.state, task: null, repos: [] })),
    },
    ceo: { source: "example", items: [exampleCeo] },
    swarm: {
      source: "example",
      desktop: desktopGraph,
      phone: phoneGraph,
      request: requestGraph,
      nodes: [],
    },
  };
}

export function usesExampleFixtures(snapshot: TowerSnapshot): boolean {
  return (
    snapshot.requests.source === "example" ||
    snapshot.needs.source === "example" ||
    snapshot.bots.source === "example" ||
    snapshot.ceo.source === "example" ||
    snapshot.swarm.source === "example" ||
    snapshot.counts.some((item) => item.source === "example")
  );
}

export function exampleLabels(snapshot: TowerSnapshot): string[] {
  if (!usesExampleFixtures(snapshot)) return [];
  return [EXAMPLE_LABEL];
}

export function assembleTower(input: TowerInputs): TowerSnapshot {
  const example = exampleTowerSnapshot();
  const connector = input.connector;
  const cursor = input.cursor;
  const cap = input.agentCap ?? SANDBOX_SLOT_CAP;
  const botsLive = connector?.bots && connector.bots.length > 0 ? connector.bots : null;
  const requestsLive = connector?.requests && connector.requests.length > 0 ? connector.requests : null;
  const needsLive = (connector?.approvals ?? []).filter((item) => item.status === "pending");
  const ceoEvents = connector?.events
    ? [...connector.events].filter((event) => CEO_ACTIONS.has(event.action)).sort((a, b) => b.at.localeCompare(a.at))
    : [];
  const agents = connector?.agents ?? [];
  const cursorRuns = cursor?.runs ?? [];
  const botById = new Map((botsLive ?? []).map((bot) => [bot.id, bot]));

  const bots: TowerPanel<TowerBot> = botsLive
    ? {
        source: "live",
        items: botsLive.map((bot) => ({
          name: bot.name,
          state: botState(bot, input.nowMs),
          task: bot.currentTask,
          repos: bot.repos,
        })),
      }
    : example.bots;

  const requests: TowerPanel<TowerRequest> = requestsLive
    ? {
        source: "live",
        items: requestsLive.map((row) => ({
          id: row.id,
          title: row.goal.slice(0, 80),
          status: requestStatus(row.status),
          owner: (row.assignedBotId && botById.get(row.assignedBotId)?.name) || "unassigned",
          body: row.notices[0] ?? null,
        })),
      }
    : example.requests;

  const needs: TowerPanel<TowerNeed> =
    needsLive.length > 0
      ? {
          source: "live",
          items: needsLive.map((row) => ({
            id: row.id,
            text: row.target && row.target !== row.action ? `${row.action} ${row.target}` : row.action,
          })),
        }
      : example.needs;

  const ceo =
    ceoEvents.length > 0
      ? { source: "live" as const, items: ceoEvents.slice(0, 5).map(ceoLine) }
      : example.ceo;

  const swarmNodes: SwarmNode[] = [];
  if (botsLive) {
    const ceoBot = botsLive.find((bot) => bot.kind === "ceo") ?? botsLive[0];
    for (const bot of botsLive) {
      swarmNodes.push({
        id: bot.id,
        label: bot.name,
        parentId: bot.id === ceoBot.id ? null : ceoBot.id,
        tone: botTone(botState(bot, input.nowMs)),
      });
    }
    for (const agent of agents) {
      swarmNodes.push({
        id: agent.id,
        label: agent.role,
        parentId: botById.has(agent.botId) ? agent.botId : ceoBot.id,
        tone: ACTIVE_AGENT.has(agent.status) ? "live" : "forming",
      });
    }
  }
  for (const run of cursorRuns) {
    const known = agents.some((agent) => agent.cursorHandle === run.id || agent.id === run.id);
    if (known) continue;
    swarmNodes.push({
      id: run.id,
      label: run.name?.trim() || shortId(run.id),
      parentId: swarmNodes.find((node) => node.parentId === null)?.id ?? null,
      tone: "live",
    });
  }

  const liveSwarm = swarmNodes.length > 0;
  const liveLinks = swarmNodes.filter((node) => node.tone === "live").length;
  const rootLabel = swarmNodes.find((node) => node.parentId === null)?.label ?? "Swarm";
  const swarmStatus = `${rootLabel} · ${liveLinks} of ${swarmNodes.length} links live`;
  const swarm = liveSwarm
    ? {
        source: "live" as const,
        desktop: graphFromSwarm(swarmNodes, { width: 860, height: 860 }, swarmStatus),
        phone: graphFromSwarm(swarmNodes, { width: 390, height: 712 }, swarmStatus),
        request: graphFromSwarm(swarmNodes.slice(0, 3), { width: 960, height: 860 }, swarmStatus),
        nodes: swarmNodes,
      }
    : { ...example.swarm, desktop: { ...desktopGraph, status: SWARM_STATUS } };

  const activeAgents = new Set<string>();
  for (const agent of agents) {
    if (ACTIVE_AGENT.has(agent.status)) activeAgents.add(agent.cursorHandle ?? agent.id);
  }
  for (const run of cursorRuns) activeAgents.add(run.id);
  const agentsLive = Array.isArray(connector?.agents) || cursor != null;
  const healthLive = Boolean(botsLive);
  const councilLive = Array.isArray(connector?.events);
  const cursorUsageLive = Boolean(cursor?.usageText);

  const counts: TowerCount[] = [
    {
      label: "Agents",
      value: agentsLive ? `${activeAgents.size}/${cap}` : example.counts[0].value,
      source: agentsLive ? "live" : "example",
    },
    {
      label: "Cursor",
      value: cursorUsageLive && cursor?.usageText ? cursor.usageText : example.counts[1].value,
      source: cursorUsageLive ? "live" : "example",
    },
    {
      label: "Council",
      value: councilLive ? String(weekCouncil(connector?.events ?? [], input.nowMs)) : example.counts[2].value,
      source: councilLive ? "live" : "example",
    },
    {
      label: "Health",
      value: healthLive
        ? `${bots.items.filter((bot) => bot.state === "live").length}/${bots.items.length}`
        : example.counts[3].value,
      source: healthLive ? "live" : "example",
    },
  ];

  return { stopped: Boolean(connector?.stopped), counts, requests, needs, bots, ceo, swarm };
}
