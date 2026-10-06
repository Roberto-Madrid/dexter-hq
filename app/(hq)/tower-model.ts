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
import { decisionTrail, type TrailEntry } from "../../hq/decision-trail.ts";

export type DataSource = "live" | "example";

export type TowerCount = { label: string; value: string; source: DataSource; detail?: string };

export type TowerRequest = {
  id: string;
  title: string;
  status: RequestStatus;
  owner: string;
  body: string | null;
  trail: TrailEntry[];
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
  ring?: 1 | 2;
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
const DONE_AGENT = new Set([
  "FINISHED",
  "ERROR",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "STOPPED",
  "finished",
  "done",
  "failed",
  "cancelled",
  "stopped",
  "complete",
  "COMPLETED",
]);
const DEXTER_HUB_ID = "dexter";
const LABEL_CHAR_W = 6.4;
const LABEL_LINE_H = 13;

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

function isActiveStatus(status?: string): boolean {
  return Boolean(status && ACTIVE_AGENT.has(status));
}

function agentTone(status?: string): SwarmNode["tone"] {
  if (!status) return "forming";
  if (ACTIVE_AGENT.has(status)) return "live";
  if (DONE_AGENT.has(status)) return "dim";
  return "forming";
}

function wrapLabel(text: string, maxChars = 20): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [""];
  if (trimmed.length <= maxChars) return [trimmed];
  const words = trimmed.split(/\s+/);
  if (words.length === 1) {
    return [trimmed.slice(0, maxChars), trimmed.slice(maxChars)];
  }
  const lines = ["", ""];
  for (const word of words) {
    const slot = lines[0] && lines[0].length + word.length + 1 > maxChars ? 1 : 0;
    lines[slot] = lines[slot] ? `${lines[slot]} ${word}` : word;
  }
  return lines.filter(Boolean).slice(0, 2);
}

function labelSize(lines: string[]): { width: number; height: number } {
  const width = Math.min(160, Math.max(24, ...lines.map((line) => Math.ceil(line.length * LABEL_CHAR_W))));
  return { width, height: lines.length * LABEL_LINE_H };
}

function boxesOverlap(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
  gap = 3,
): boolean {
  return !(
    a.left + a.width + gap <= b.left ||
    b.left + b.width + gap <= a.left ||
    a.top + a.height + gap <= b.top ||
    b.top + b.height + gap <= a.top
  );
}

function placeOnRing(
  items: SwarmNode[],
  placed: Map<string, { x: number; y: number; angle: number }>,
  cx: number,
  cy: number,
  radius: number,
): void {
  const count = Math.max(items.length, 1);
  items.forEach((item, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
    placed.set(item.id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      angle,
    });
  });
}

function ringRadius(size: { width: number; height: number }, count: number, inner: boolean, hasOuter: boolean): number {
  const minDim = Math.min(size.width, size.height);
  if (count <= 0) return minDim * 0.22;
  const needed = (count * 56) / (2 * Math.PI);
  if (inner && hasOuter) return Math.min(minDim * 0.24, Math.max(minDim * 0.18, needed * 0.55));
  if (inner) return Math.min(minDim * 0.38, Math.max(minDim * 0.24, needed));
  return Math.min(minDim * 0.42, Math.max(minDim * 0.34, needed));
}

const HUB_R = 4.5;
const SPOKE_R = 3.5;
export const PHONE_SWARM_VIEWPORT = { width: 390, height: 844 };
export const PHONE_SWARM_CHROME = 132;

function isPhoneSwarm(size: { width: number; height: number }): boolean {
  return size.width <= 390;
}

function phoneRingRadius(size: { width: number; height: number }): number {
  const cx = size.width / 2;
  const cy = size.height / 2;
  return Math.max(72, Math.min(cx, cy) - 78);
}

function pointInBox(
  x: number,
  y: number,
  box: { left: number; top: number; width: number; height: number },
): boolean {
  return x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height;
}

function segmentsCross(
  a1x: number,
  a1y: number,
  a2x: number,
  a2y: number,
  b1x: number,
  b1y: number,
  b2x: number,
  b2y: number,
): boolean {
  const d = (a2x - a1x) * (b2y - b1y) - (a2y - a1y) * (b2x - b1x);
  if (d === 0) return false;
  const t = ((b1x - a1x) * (b2y - b1y) - (b1y - a1y) * (b2x - b1x)) / d;
  const u = ((b1x - a1x) * (a2y - a1y) - (b1y - a1y) * (a2x - a1x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export function edgeCrossesLabel(
  line: { x1: number; y1: number; x2: number; y2: number },
  box: { left: number; top: number; width: number; height: number },
): boolean {
  if (box.width <= 0 || box.height <= 0) return false;
  if (pointInBox(line.x1, line.y1, box) || pointInBox(line.x2, line.y2, box)) return true;
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  return (
    segmentsCross(line.x1, line.y1, line.x2, line.y2, box.left, box.top, right, box.top) ||
    segmentsCross(line.x1, line.y1, line.x2, line.y2, right, box.top, right, bottom) ||
    segmentsCross(line.x1, line.y1, line.x2, line.y2, right, bottom, box.left, bottom) ||
    segmentsCross(line.x1, line.y1, line.x2, line.y2, box.left, bottom, box.left, box.top)
  );
}

function insetToward(
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const t = Math.min(radius / len, 0.45);
  return { x: from.x + dx * t, y: from.y + dy * t };
}

function padBox(
  box: { left: number; top: number; width: number; height: number },
  pad: number,
): { left: number; top: number; width: number; height: number } {
  return { left: box.left - pad, top: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
}

function circleHitsBox(
  cx: number,
  cy: number,
  radius: number,
  box: { left: number; top: number; width: number; height: number },
  pad = 2,
): boolean {
  const closestX = Math.min(box.left + box.width, Math.max(box.left, cx));
  const closestY = Math.min(box.top + box.height, Math.max(box.top, cy));
  return Math.hypot(cx - closestX, cy - closestY) < radius + pad;
}

function phoneSpokeSegments(
  hub: { x: number; y: number },
  spoke: { x: number; y: number },
  stroke: string,
  hubBox: { left: number; top: number; width: number; height: number },
): { x1: number; y1: number; x2: number; y2: number; stroke: string }[] {
  const hubEnd = insetToward(hub, spoke, HUB_R);
  const spokeEnd = insetToward(spoke, hub, SPOKE_R);
  const straight = { x1: hubEnd.x, y1: hubEnd.y, x2: spokeEnd.x, y2: spokeEnd.y, stroke };
  const clear = padBox(hubBox, 1);
  if (!edgeCrossesLabel(straight, clear)) return [straight];
  const box = padBox(hubBox, 2);
  const routeAbove = spoke.y <= box.top + box.height / 2;
  const waypoint = {
    x: box.left - 1,
    y: routeAbove ? box.top - 2 : box.top + box.height + 2,
  };
  let innerHub = insetToward(hub, waypoint, HUB_R);
  let inner = { x1: innerHub.x, y1: innerHub.y, x2: waypoint.x, y2: waypoint.y, stroke };
  let outer = { x1: waypoint.x, y1: waypoint.y, x2: spokeEnd.x, y2: spokeEnd.y, stroke };
  for (let step = 0; step < 6 && (edgeCrossesLabel(inner, clear) || edgeCrossesLabel(outer, clear)); step += 1) {
    waypoint.y += routeAbove ? -3 : 3;
    waypoint.x = Math.min(waypoint.x, box.left - 1);
    innerHub = insetToward(hub, waypoint, HUB_R);
    inner = { x1: innerHub.x, y1: innerHub.y, x2: waypoint.x, y2: waypoint.y, stroke };
    outer = { x1: waypoint.x, y1: waypoint.y, x2: spokeEnd.x, y2: spokeEnd.y, stroke };
  }
  return [inner, outer];
}

type PlacedLabel = {
  left: number;
  top: number;
  width: number;
  height: number;
  align: "left" | "right" | "center";
  color: string;
  weight: 400 | 500;
  lines: string[];
  angle: number;
};

function hubLabel(
  node: SwarmNode,
  point: { x: number; y: number },
): PlacedLabel {
  const lines = [node.label.trim() || "Dexter"];
  const box = labelSize(lines);
  return {
    left: point.x + 12,
    top: point.y - 6,
    width: Math.max(box.width, 34),
    height: box.height,
    align: "left",
    color: INK,
    weight: 500,
    lines,
    angle: 0,
  };
}

function labelOutsideDot(
  node: SwarmNode,
  point: { x: number; y: number; angle: number },
  size: { width: number; height: number },
  nodeR: number,
  wrap: boolean,
): PlacedLabel | null {
  const lines = wrap ? wrapLabel(node.label) : [node.label.trim()].filter(Boolean);
  if (lines.length === 0) return null;
  const box = labelSize(lines);
  const color = toneFill(node.tone) === DIM ? DIM : toneFill(node.tone);
  const cos = Math.cos(point.angle);
  const sin = Math.sin(point.angle);
  const gap = nodeR + 6;
  const ax = point.x + cos * gap;
  const ay = point.y + sin * gap;
  let align: PlacedLabel["align"] = "left";
  let left = ax;
  let top = ay - box.height / 2;
  if (Math.abs(cos) >= Math.abs(sin)) {
    if (cos < 0) {
      align = "right";
      left = ax - box.width;
    }
  } else {
    align = "center";
    left = ax - box.width / 2;
    top = sin < 0 ? ay - box.height : ay;
  }
  const footer = 36;
  if (left < 8 || top < 8 || left + box.width > size.width - 8 || top + box.height > size.height - footer) {
    return null;
  }
  return {
    left,
    top,
    width: box.width,
    height: box.height,
    align,
    color,
    weight: 400,
    lines,
    angle: point.angle,
  };
}

function labelForNode(
  node: SwarmNode,
  point: { x: number; y: number; angle: number },
  size: { width: number; height: number },
): PlacedLabel {
  const lines = wrapLabel(node.label);
  const box = labelSize(lines);
  const color = toneFill(node.tone) === DIM ? DIM : node.parentId ? toneFill(node.tone) : INK;
  if (!node.parentId) {
    return hubLabel(node, point);
  }
  const pad = 10;
  const cos = Math.cos(point.angle);
  const sin = Math.sin(point.angle);
  let align: PlacedLabel["align"] = "left";
  let left = point.x + pad;
  let top = point.y - box.height / 2;
  if (Math.abs(cos) < 0.42) {
    align = "center";
    left = point.x - box.width / 2;
    top = sin < 0 ? point.y - 8 - box.height : point.y + 8;
  } else if (cos < 0) {
    align = "right";
    left = point.x - pad - box.width;
  }
  const maxLeft = size.width - box.width - 8;
  const maxTop = size.height - box.height - 36;
  return {
    left: Math.min(maxLeft, Math.max(8, left)),
    top: Math.min(maxTop, Math.max(8, top)),
    width: box.width,
    height: box.height,
    align,
    color,
    weight: 400,
    lines,
    angle: point.angle,
  };
}

function separateLabels(labels: PlacedLabel[], size: { width: number; height: number }): void {
  for (let pass = 0; pass < 8; pass += 1) {
    let moved = false;
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        const a = labels[i];
        const b = labels[j];
        if (!boxesOverlap(a, b)) continue;
        const push = 10;
        const target = Math.abs(Math.sin(b.angle)) >= Math.abs(Math.sin(a.angle)) ? b : a;
        target.left += Math.cos(target.angle) * push;
        target.top += Math.sin(target.angle) * push;
        target.left = Math.min(size.width - target.width - 8, Math.max(8, target.left));
        target.top = Math.min(size.height - target.height - 36, Math.max(8, target.top));
        moved = true;
      }
    }
    if (!moved) return;
  }
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
  const placed = new Map<string, { x: number; y: number; angle: number }>();
  if (roots.length === 0) {
    return { width: size.width, height: size.height, status, lines: [], nodes: [], labels: [] };
  }
  const root =
    roots.find((node) => node.label.trim().toLowerCase() === "dexter") ??
    roots.find((node) => node.id === DEXTER_HUB_ID) ??
    roots[0];
  placed.set(root.id, { x: cx, y: cy, angle: 0 });
  const phone = isPhoneSwarm(size);
  const first = [...(children.get(root.id) ?? []), ...roots.filter((node) => node.id !== root.id)];
  const inner = first.filter((node) => node.ring !== 2);
  const outer = first.filter((node) => node.ring === 2);
  const nested: SwarmNode[] = [];
  for (const child of first) {
    nested.push(...(children.get(child.id) ?? []));
  }
  const ring2 = outer.length > 0 ? outer : nested;
  const ring1 = inner;
  if (phone) {
    const leaves = nodes.filter((node) => node.id !== root.id);
    placeOnRing(leaves, placed, cx, cy, phoneRingRadius(size));
  } else {
    placeOnRing(ring1, placed, cx, cy, ringRadius(size, ring1.length, true, ring2.length > 0));
    if (ring2.length > 0) {
      placeOnRing(ring2, placed, cx, cy, ringRadius(size, ring2.length, false, true));
    }
  }
  for (const node of nodes) {
    if (placed.has(node.id)) continue;
    placed.set(node.id, { x: cx, y: cy + ringRadius(size, 1, true, false), angle: Math.PI / 2 });
  }
  const hubPoint = placed.get(root.id) ?? { x: cx, y: cy };
  const hub = hubLabel(root, hubPoint);
  const hubBox = { left: hub.left, top: hub.top, width: hub.width, height: hub.height };
  const lines = nodes.flatMap((node) => {
    const parentId = node.parentId && byId.has(node.parentId) ? node.parentId : node.id === root.id ? null : root.id;
    if (!parentId) return [];
    const from = placed.get(parentId);
    const to = placed.get(node.id);
    if (!from || !to) return [];
    if (!phone) return [{ x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: toneFill(node.tone) }];
    return phoneSpokeSegments(from, to, toneFill(node.tone), hubBox);
  });
  const radials = nodes.flatMap((node) => {
    const parentId = node.parentId && byId.has(node.parentId) ? node.parentId : node.id === root.id ? null : root.id;
    if (!parentId) return [];
    const from = placed.get(parentId);
    const to = placed.get(node.id);
    if (!from || !to) return [];
    const start = insetToward(from, to, from === placed.get(root.id) ? HUB_R : SPOKE_R);
    const end = insetToward(to, from, to === placed.get(root.id) ? HUB_R : SPOKE_R);
    return [{ x1: start.x, y1: start.y, x2: end.x, y2: end.y }];
  });
  const labels: PlacedLabel[] = nodes.map((node) => {
    const point = placed.get(node.id) ?? { x: cx, y: cy, angle: 0 };
    if (!phone) return labelForNode(node, point, size);
    if (node.id === root.id) return hub;
    return {
      left: point.x,
      top: point.y,
      width: 0,
      height: 0,
      align: "left" as const,
      color: DIM,
      weight: 400 as const,
      lines: [] as string[],
      angle: point.angle,
    };
  });
  if (phone) {
    const kept: PlacedLabel[] = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node.id === root.id) continue;
      const point = placed.get(node.id);
      if (!point) continue;
      const base = labelOutsideDot(node, point, size, SPOKE_R, false);
      if (!base) continue;
      let candidate: PlacedLabel | null = null;
      const blocked = (box: { left: number; top: number; width: number; height: number }) =>
        kept.some((label) => boxesOverlap(label, box, 4)) ||
        labels.some((label, labelIndex) => labelIndex !== index && label.lines.length > 0 && boxesOverlap(label, box, 4)) ||
        radials.some((line) => edgeCrossesLabel(line, box)) ||
        lines.some((line) => edgeCrossesLabel(line, box));
      const hitsNeighbor = (box: { left: number; top: number; width: number; height: number }) =>
        nodes.some((other) => {
          if (other.id === node.id || other.id === root.id) return false;
          const otherPoint = placed.get(other.id);
          if (!otherPoint) return false;
          return circleHitsBox(otherPoint.x, otherPoint.y, SPOKE_R, box, 3);
        });
      for (let extra = 0; extra <= 28; extra += 4) {
        const next = extra === 0 ? base : labelOutsideDot(node, point, size, SPOKE_R + extra, false);
        if (!next) continue;
        const box = { left: next.left, top: next.top, width: next.width, height: next.height };
        if (blocked(box)) {
          if (extra === 0) break;
          continue;
        }
        if (hitsNeighbor(box)) continue;
        candidate = next;
        break;
      }
      if (!candidate) continue;
      labels[index] = candidate;
      kept.push(candidate);
    }
  } else {
    separateLabels(
      labels.filter((label) => label.weight !== 500),
      size,
    );
  }
  return {
    width: size.width,
    height: size.height,
    status,
    lines,
    nodes: nodes.map((node) => {
      const point = placed.get(node.id) ?? { x: cx, y: cy };
      return { cx: point.x, cy: point.y, r: node.parentId ? SPOKE_R : HUB_R, fill: toneFill(node.tone) };
    }),
    labels: labels.map((label) => ({
      left: label.left,
      top: label.top,
      width: label.width,
      align: label.align,
      color: label.color,
      weight: label.weight,
      lines: label.lines,
    })),
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
    requests: { source: "example", items: exampleRequests.map((item) => ({ ...item, trail: [] })) },
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
          trail: decisionTrail(connector?.events ?? [], row.id),
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

  const hasSwarmMembers = Boolean(botsLive) || agents.length > 0 || cursorRuns.length > 0;
  const swarmNodes: SwarmNode[] = [];
  if (hasSwarmMembers) {
    const ceoBot =
      botsLive?.find((bot) => bot.kind === "ceo") ??
      botsLive?.find((bot) => bot.name.trim().toLowerCase() === "dexter");
    const rootId = ceoBot?.id ?? DEXTER_HUB_ID;
    swarmNodes.push({
      id: rootId,
      label: "Dexter",
      parentId: null,
      tone: ceoBot ? botTone(botState(ceoBot, input.nowMs)) : "live",
    });
    for (const bot of botsLive ?? []) {
      if (bot.id === rootId) continue;
      swarmNodes.push({
        id: bot.id,
        label: bot.name,
        parentId: rootId,
        tone: botTone(botState(bot, input.nowMs)),
        ring: 1,
      });
    }
    for (const agent of agents) {
      swarmNodes.push({
        id: agent.id,
        label: agent.role,
        parentId: rootId,
        tone: agentTone(agent.status),
        ring: 2,
      });
    }
    for (const run of cursorRuns) {
      const known = agents.some((agent) => agent.cursorHandle === run.id || agent.id === run.id);
      if (known) continue;
      swarmNodes.push({
        id: run.id,
        label: run.name?.trim() || shortId(run.id),
        parentId: rootId,
        tone: agentTone(run.status),
        ring: 2,
      });
    }
  }

  const liveSwarm = swarmNodes.length > 0;
  const liveLinks = swarmNodes.filter((node) => node.parentId && node.tone === "live").length;
  const swarmStatus = `Growing from Dexter · ${liveLinks} of ${Math.max(swarmNodes.length - 1, 0)} links live`;
  const swarm = liveSwarm
    ? {
        source: "live" as const,
        desktop: graphFromSwarm(swarmNodes, { width: 860, height: 860 }, swarmStatus),
        phone: graphFromSwarm(
          swarmNodes,
          { width: PHONE_SWARM_VIEWPORT.width, height: PHONE_SWARM_VIEWPORT.height - PHONE_SWARM_CHROME },
          swarmStatus,
        ),
        request: graphFromSwarm(
          swarmNodes.filter((node) => !node.parentId || node.ring === 1).slice(0, 3),
          { width: 960, height: 860 },
          swarmStatus,
        ),
        nodes: swarmNodes,
      }
    : { ...example.swarm, desktop: { ...desktopGraph, status: SWARM_STATUS } };

  const activeAgents = new Set<string>();
  for (const agent of agents) {
    if (isActiveStatus(agent.status)) activeAgents.add(agent.cursorHandle ?? agent.id);
  }
  for (const run of cursorRuns) {
    if (!isActiveStatus(run.status)) continue;
    activeAgents.add(run.id);
  }
  const liveContext = connector != null || cursor != null;
  const agentsLive = liveContext;
  const healthLive = Boolean(botsLive);
  const councilLive = Array.isArray(connector?.events);
  const cursorUsage = cursor?.usageText?.trim() || "";

  const counts: TowerCount[] = [
    agentsLive
      ? { label: "Agents", value: String(activeAgents.size), detail: `of ${cap}`, source: "live" }
      : { label: "Agents", value: example.counts[0].value, source: "example" },
    cursorUsage
      ? { label: "Cursor", value: cursorUsage, source: "live" }
      : liveContext
        ? { label: "Cursor", value: "unknown", source: "live" }
        : { label: "Cursor", value: example.counts[1].value, source: "example" },
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
