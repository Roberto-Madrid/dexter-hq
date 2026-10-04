export const EXAMPLE_LABEL = "Example";

export const exampleCounts = [
  { label: "Agents", value: "2/4" },
  { label: "Cursor", value: "18%" },
  { label: "Council", value: "3" },
  { label: "Health", value: "4/5" },
] as const;

export type RequestStatus = "needs" | "active" | "queued" | "done";

export const STATUS_COPY: Record<RequestStatus, string> = {
  needs: "Needs you",
  active: "Active",
  queued: "Queued",
  done: "Done",
};

export const exampleRequests = [
  {
    id: "point-production",
    title: "Point production at v5",
    status: "needs" as const,
    owner: "HQ Dev",
    body: "Production still tracks main. v5 is the integration branch.",
  },
  {
    id: "design-gate",
    title: "Design gate two directions",
    status: "active" as const,
    owner: "Designer",
    body: null,
  },
  {
    id: "connector-stub",
    title: "Connector stub as MCP",
    status: "queued" as const,
    owner: "HQ Dev",
    body: null,
  },
  {
    id: "path-b",
    title: "Path B council seat",
    status: "done" as const,
    owner: "QA",
    body: null,
  },
];

export const exampleNeeds = [
  "Set the Vercel production branch to v5",
  "Confirm a design direction.",
];

export const exampleBots = [
  { name: "Dexter", state: "live" as const },
  { name: "HQ Dev", state: "live" as const },
  { name: "Designer", state: "live" as const },
  { name: "QA", state: "waiting" as const },
  { name: "dreggbot", state: "idle" as const },
];

export const exampleCeo = "Council sat on the connector route.";

export const SWARM_STATUS = "Growing from Dexter · 2 of 4 links live";
export const LOCAL_GRAPH_STATUS = "Local graph · grown from Dexter";

export type GraphLine = { x1: number; y1: number; x2: number; y2: number; stroke: string };
export type GraphNode = { cx: number; cy: number; r: number; fill: string };
export type GraphLabel = {
  left: number;
  top: number;
  width: number;
  align: "left" | "right" | "center";
  color: string;
  weight: 400 | 500;
  lines: string[];
};

export type GraphModel = {
  width: number;
  height: number;
  lines: GraphLine[];
  nodes: GraphNode[];
  labels: GraphLabel[];
  status: string;
};

export const LIVE = "#0E7490";
export const FORMING = "#B45309";
export const DIM = "#C5D0D6";
export const INK = "#102026";

export const desktopGraph: GraphModel = {
  width: 860,
  height: 860,
  status: SWARM_STATUS,
  lines: [
    { x1: 430, y1: 430, x2: 508.43, y2: 304.49, stroke: LIVE },
    { x1: 430, y1: 430, x2: 296.98, y2: 365.12, stroke: LIVE },
    { x1: 508.43, y1: 304.49, x2: 540.47, y2: 203.5, stroke: FORMING },
    { x1: 508.43, y1: 304.49, x2: 674.83, y2: 320.99, stroke: FORMING },
    { x1: 296.98, y1: 365.12, x2: 178.15, y2: 357.78, stroke: LIVE },
    { x1: 508.43, y1: 304.49, x2: 378.85, y2: 189.38, stroke: DIM },
    { x1: 430, y1: 430, x2: 388.31, y2: 508.41, stroke: FORMING },
  ],
  nodes: [
    { cx: 430, cy: 430, r: 4.5, fill: LIVE },
    { cx: 508.43, cy: 304.49, r: 3.5, fill: LIVE },
    { cx: 296.98, cy: 365.12, r: 3.5, fill: LIVE },
    { cx: 360.52, cy: 560.68, r: 3.5, fill: FORMING },
    { cx: 558.17, cy: 504, r: 3.5, fill: DIM },
    { cx: 674.83, cy: 320.99, r: 3.5, fill: FORMING },
    { cx: 540.47, cy: 203.5, r: 3.5, fill: FORMING },
    { cx: 378.85, cy: 189.38, r: 3.5, fill: DIM },
    { cx: 178.15, cy: 357.78, r: 3.5, fill: LIVE },
    { cx: 304.18, cy: 666.63, r: 3.5, fill: DIM },
  ],
  labels: [
    { left: 442.5, top: 423.5, width: 34, align: "left", color: INK, weight: 500, lines: ["Dexter"] },
    { left: 456.93, top: 297.99, width: 40, align: "right", color: LIVE, weight: 400, lines: ["HQ Dev"] },
    { left: 274.48, top: 340.62, width: 45, align: "center", color: LIVE, weight: 400, lines: ["Designer"] },
    { left: 333.02, top: 554.18, width: 16, align: "right", color: FORMING, weight: 400, lines: ["QA"] },
    { left: 569.67, top: 497.5, width: 44, align: "left", color: DIM, weight: 400, lines: ["dreggbot"] },
    { left: 686.33, top: 314.49, width: 107, align: "left", color: FORMING, weight: 400, lines: ["Point production at v5"] },
    { left: 551.97, top: 197, width: 48, align: "left", color: FORMING, weight: 400, lines: ["bots table"] },
    { left: 250.35, top: 182.88, width: 117, align: "right", color: DIM, weight: 400, lines: ["Connector stub as MCP"] },
    { left: 36.65, top: 351.28, width: 130, align: "right", color: LIVE, weight: 400, lines: ["Design gate two directions"] },
    { left: 197.68, top: 660.13, width: 95, align: "right", color: DIM, weight: 400, lines: ["Path B council seat"] },
  ],
};

export const requestGraph: GraphModel = {
  width: 960,
  height: 860,
  status: LOCAL_GRAPH_STATUS,
  lines: [
    { x1: 480, y1: 430, x2: 608.7, y2: 322.01, stroke: LIVE },
    { x1: 608.7, y1: 322.01, x2: 728.2, y2: 221.74, stroke: FORMING },
  ],
  nodes: [
    { cx: 480, cy: 430, r: 4.5, fill: LIVE },
    { cx: 608.7, cy: 322.01, r: 3.5, fill: LIVE },
    { cx: 728.2, cy: 221.74, r: 3.5, fill: FORMING },
  ],
  labels: [
    { left: 492.5, top: 423.5, width: 34, align: "left", color: INK, weight: 500, lines: ["Dexter"] },
    { left: 588.7, top: 333.51, width: 40, align: "center", color: LIVE, weight: 400, lines: ["HQ Dev"] },
    { left: 739.7, top: 215.24, width: 107, align: "left", color: FORMING, weight: 400, lines: ["Point production at v5"] },
  ],
};

export const phoneGraph: GraphModel = {
  width: 390,
  height: 712,
  status: SWARM_STATUS,
  lines: [
    { x1: 195, y1: 356, x2: 266.99, y2: 270.2, stroke: LIVE },
    { x1: 195, y1: 356, x2: 103.25, y2: 291.76, stroke: LIVE },
    { x1: 266.99, y1: 270.2, x2: 226.19, y2: 209.28, stroke: FORMING },
    { x1: 266.99, y1: 270.2, x2: 326.06, y2: 260.78, stroke: FORMING },
    { x1: 103.25, y1: 291.76, x2: 49.19, y2: 253.9, stroke: LIVE },
    { x1: 266.99, y1: 270.2, x2: 133.56, y2: 203.94, stroke: DIM },
    { x1: 195, y1: 356, x2: 151.8, y2: 407.48, stroke: FORMING },
  ],
  nodes: [
    { cx: 195, cy: 356, r: 4.5, fill: LIVE },
    { cx: 266.99, cy: 270.2, r: 3.5, fill: LIVE },
    { cx: 103.25, cy: 291.76, r: 3.5, fill: LIVE },
    { cx: 123.01, cy: 441.8, r: 3.5, fill: FORMING },
    { cx: 280.8, cy: 427.99, r: 3.5, fill: DIM },
    { cx: 226.19, cy: 209.28, r: 3.5, fill: FORMING },
    { cx: 326.06, cy: 260.78, r: 3.5, fill: FORMING },
    { cx: 133.56, cy: 203.94, r: 3.5, fill: DIM },
    { cx: 49.19, cy: 253.9, r: 3.5, fill: LIVE },
    { cx: 75.44, cy: 498.48, r: 3.5, fill: DIM },
  ],
  labels: [
    { left: 207.5, top: 349.5, width: 34, align: "left", color: INK, weight: 500, lines: ["Dexter"] },
    { left: 215.49, top: 263.7, width: 40, align: "right", color: LIVE, weight: 400, lines: ["HQ Dev"] },
    { left: 46.75, top: 285.26, width: 45, align: "right", color: LIVE, weight: 400, lines: ["Designer"] },
    { left: 95.51, top: 435.3, width: 16, align: "right", color: FORMING, weight: 400, lines: ["QA"] },
    { left: 292.3, top: 421.49, width: 44, align: "left", color: DIM, weight: 400, lines: ["dreggbot"] },
    { left: 202.19, top: 184.78, width: 48, align: "center", color: FORMING, weight: 400, lines: ["bots table"] },
    { left: 289.06, top: 223.28, width: 74, align: "center", color: FORMING, weight: 400, lines: ["Point production", "at v5"] },
    { left: 100.06, top: 166.44, width: 67, align: "center", color: DIM, weight: 400, lines: ["Connector stub", "as MCP"] },
    { left: 17.69, top: 216.4, width: 63, align: "center", color: LIVE, weight: 400, lines: ["Design gate", "two directions"] },
    { left: 48.94, top: 509.98, width: 53, align: "center", color: DIM, weight: 400, lines: ["Path B", "council seat"] },
  ],
};
