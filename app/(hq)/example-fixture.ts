export const EXAMPLE_LABEL = "Example";

export const exampleCounts = [
  { label: "Agents", value: "2/4" },
  { label: "Cursor", value: "18%" },
  { label: "Council", value: "0" },
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
    age: "12m",
    events: 2,
    body: "Dexter prepared the Vercel production alias cut to branch v5. Owner must approve the branch target before HQ Dev applies it.",
  },
  {
    id: "design-gate",
    title: "Design gate, two directions",
    status: "active" as const,
    owner: "Designer",
    age: "41m",
    events: 6,
    body: null,
  },
  {
    id: "connector-stub",
    title: "Connector stub as MCP",
    status: "queued" as const,
    owner: "HQ Dev",
    age: "1h",
    events: 1,
    body: null,
  },
  {
    id: "path-b",
    title: "Path B council seat",
    status: "done" as const,
    owner: "QA",
    age: "3h",
    events: 4,
    body: null,
  },
];

export const exampleNeeds = [
  "Set the Vercel production branch to v5",
  "Confirm a design direction",
];

export const exampleNeedMeta = [
  { owner: "HQ Dev", age: "12m", urgent: true },
  { owner: "Designer", age: "41m", urgent: false },
];

export const exampleBots = [
  { name: "Dexter planning", state: "live" as const, hb: "4s" },
  { name: "HQ Dev connector", state: "live" as const, hb: "9s" },
  { name: "Designer references", state: "live" as const, hb: "6s" },
  { name: "QA idle", state: "idle" as const, hb: "—" },
];

export const exampleCeo = "HQ Dev and Designer Live. QA Idle. Vercel cutover Wait · Needs you. Growing 2 of 4 links live.";

export type ChatRole = "dexter" | "you";
export type ChatMessage = { role: ChatRole; when: string; text: string };

export const exampleChat: ChatMessage[] = [
  { role: "dexter", when: "2h", text: "Cut production to v5 after the design pick. Gate frames are Live under Designer." },
  { role: "you", when: "1h", text: "Hold Path B council until the gate closes." },
  { role: "dexter", when: "58m", text: "Acknowledged. Path B stays Done. Connector stub MCP is queued, not blocked." },
  { role: "you", when: "41m", text: "Where are we on production?" },
  { role: "dexter", when: "12m", text: "Ready to point production at branch v5. HQ Dev opened the cutover — Needs you to Approve." },
  { role: "you", when: "8m", text: "Show swarm state." },
  { role: "dexter", when: "4m", text: "HQ Dev and Designer Live. QA Idle. Vercel cutover Wait · Needs you. Growing 2 of 4 links live." },
];

export const exampleActivity = [
  { when: "12m", text: "HQ Dev opened request Point production at v5" },
  { when: "8m", text: "Dexter queued Vercel cutover agent under HQ Dev" },
  { when: "4m", text: "Awaiting owner Approve on production branch target" },
];

export const SWARM_STATUS = "Dexter → agents → bots → Council · 2/5 agents live · grows with demos";
export const LOCAL_GRAPH_STATUS = "Local graph · grown from Dexter";
export const SWARM_LEGEND = `<span style="color:#3DCF8E">●</span> Live &nbsp;<span style="color:#D4A017">●</span> Wait &nbsp;<span style="color:#3A4550">●</span> Idle<br/>dashed = council review · + = open slot`;

export type GraphLine = { x1: number; y1: number; x2: number; y2: number; stroke: string; dash?: string; width?: number };
export type GraphNode = { cx: number; cy: number; r: number; fill: string; stroke?: string; dash?: string; opacity?: number };
export type GraphLabel = {
  left: number;
  top: number;
  width: number;
  align: "left" | "right" | "center";
  color: string;
  weight: 400 | 500;
  lines: string[];
  fontSize?: string;
};

export type GraphModel = {
  width: number;
  height: number;
  lines: GraphLine[];
  nodes: GraphNode[];
  labels: GraphLabel[];
  status: string;
  legend?: string;
  svgInner?: string;
};

export const LIVE = "#3DCF8E";
export const FORMING = "#D4A017";
export const DIM = "#3A4550";
export const INK = "#E6EDF2";
export const HUB = "#5EEAD4";
export const MUTED = "#7E8A93";
export const LINE = "#252C33";

export const desktopGraph: GraphModel = {
  width: 520,
  height: 538,
  status: SWARM_STATUS,
  legend: SWARM_LEGEND,
  lines: [],
  nodes: [],
  svgInner: `<circle cx="260" cy="250" r="50" fill="none" stroke="#5EEAD4" stroke-width="1" opacity="0.35"/><circle cx="260" cy="250" r="99" fill="none" stroke="#252C33" stroke-width="1" opacity="0.55"/><circle cx="260" cy="250" r="162" fill="none" stroke="#252C33" stroke-width="1" opacity="0.28"/><rect x="310" y="312" width="90" height="95" fill="rgba(61,207,142,0.07)" stroke="#3DCF8E" stroke-width="1" opacity="0.7"/><rect x="344" y="208" width="94" height="39" fill="rgba(212,160,23,0.07)" stroke="#D4A017" stroke-width="1" opacity="0.7"/><rect x="102" y="109" width="96" height="91" fill="rgba(61,207,142,0.07)" stroke="#3DCF8E" stroke-width="1" opacity="0.7"/><circle cx="226" cy="343" r="5" fill="none" stroke="#252C33" stroke-width="1" stroke-dasharray="2 2" opacity="0.5"/><circle cx="227" cy="340" r="5" fill="none" stroke="#252C33" stroke-width="1" stroke-dasharray="2 2" opacity="0.5"/><line x1="260" y1="250" x2="324" y2="326" stroke="#3DCF8E" stroke-width="1.7"/><line x1="260" y1="250" x2="358" y2="233" stroke="#D4A017" stroke-width="1.15"/><line x1="260" y1="250" x2="293" y2="160" stroke="#2A333C" stroke-width="1.15"/><line x1="260" y1="250" x2="184" y2="186" stroke="#3DCF8E" stroke-width="1.7"/><line x1="260" y1="250" x2="170" y2="283" stroke="#2A333C" stroke-width="1.15"/><path d="M324 326 L335 359 L347 393" fill="none" stroke="#D4A017" stroke-width="1.2"/><path d="M324 326 L345 351 L367 377" fill="none" stroke="#D4A017" stroke-width="1.2"/><path d="M324 326 L355 343 L386 360" fill="none" stroke="#D4A017" stroke-width="1.2"/><path d="M358 233 L391 227 L424 222" fill="none" stroke="#D4A017" stroke-width="1.2"/><path d="M184 186 L166 154 L149 123" fill="none" stroke="#3DCF8E" stroke-width="1.2"/><path d="M184 186 L150 174 L116 162" fill="none" stroke="#3DCF8E" stroke-width="1.2"/><circle cx="260" cy="250" r="7" fill="#5EEAD4"/><circle cx="260" cy="250" r="11" fill="none" stroke="#5EEAD4" stroke-width="1" opacity="0.45"/><circle cx="324" cy="326" r="5.5" fill="#3DCF8E"/><circle cx="347" cy="393" r="3.5" fill="#D4A017"/><circle cx="367" cy="377" r="3.5" fill="#D4A017"/><circle cx="386" cy="360" r="3.5" fill="#D4A017"/><circle cx="358" cy="233" r="5.5" fill="#D4A017"/><circle cx="424" cy="222" r="3.5" fill="#D4A017"/><circle cx="293" cy="160" r="5.5" fill="#3A4550"/><circle cx="184" cy="186" r="5.5" fill="#3DCF8E"/><circle cx="149" cy="123" r="3.5" fill="#3DCF8E"/><circle cx="116" cy="162" r="3.5" fill="#3DCF8E"/><circle cx="170" cy="283" r="5.5" fill="#3A4550"/><line x1="16" y1="458" x2="504" y2="458" stroke="#252C33" stroke-width="1" opacity="0.6"/><circle cx="114" cy="480" r="4" fill="#D4A017"/><circle cx="114" cy="480" r="7" fill="none" stroke="#D4A017" stroke-width="1" opacity="0.55"/><line x1="114" y1="472" x2="324" y2="332" stroke="#D4A017" stroke-width="1.2" stroke-dasharray="4 3"/><circle cx="260" cy="480" r="4" fill="#D4A017"/><circle cx="260" cy="480" r="7" fill="none" stroke="#D4A017" stroke-width="1" opacity="0.55"/><line x1="260" y1="472" x2="184" y2="192" stroke="#D4A017" stroke-width="1.2" stroke-dasharray="4 3"/><circle cx="405" cy="480" r="4" fill="#3A4550"/><circle cx="405" cy="480" r="7" fill="none" stroke="#3A4550" stroke-width="1" opacity="0.55"/>`,
  labels: [
    { left: 243.5, top: 143.0, width: 33, align: "center" as const, color: "#7E8A93", weight: 400 as const, lines: ["agents"], fontSize: "9px" },
    { left: 223.25, top: 353.0, width: 5, align: "center" as const, color: "#7E8A93", weight: 400 as const, lines: ["+"], fontSize: "10px" },
    { left: 224.25, top: 350.0, width: 5, align: "center" as const, color: "#7E8A93", weight: 400 as const, lines: ["+"], fontSize: "10px" },
    { left: 272.0, top: 242.0, width: 0, align: "left" as const, color: "#E6EDF2", weight: 500 as const, lines: ["Dexter"], fontSize: "12px" },
    { left: 272.0, top: 256.0, width: 0, align: "left" as const, color: "#7E8A93", weight: 400 as const, lines: ["CEO / HQ"], fontSize: "9px" },
    { left: 335.0, top: 316.0, width: 0, align: "left" as const, color: "#3DCF8E", weight: 500 as const, lines: ["HQ Dev"], fontSize: "11px" },
    { left: 335.0, top: 330.0, width: 0, align: "left" as const, color: "#3DCF8E", weight: 400 as const, lines: ["Live \u00b7 agent"], fontSize: "9px" },
    { left: 357.0, top: 387.0, width: 0, align: "left" as const, color: "#D4A017", weight: 400 as const, lines: ["bots table"], fontSize: "10px" },
    { left: 377.0, top: 371.0, width: 0, align: "left" as const, color: "#D4A017", weight: 400 as const, lines: ["Connector"], fontSize: "10px" },
    { left: 396.0, top: 354.0, width: 0, align: "left" as const, color: "#D4A017", weight: 400 as const, lines: ["Vercel cutover"], fontSize: "10px" },
    { left: 369.0, top: 223.0, width: 0, align: "left" as const, color: "#D4A017", weight: 500 as const, lines: ["Barber"], fontSize: "11px" },
    { left: 369.0, top: 237.0, width: 0, align: "left" as const, color: "#D4A017", weight: 400 as const, lines: ["Wait \u00b7 agent"], fontSize: "9px" },
    { left: 434.0, top: 216.0, width: 0, align: "left" as const, color: "#D4A017", weight: 400 as const, lines: ["Cut queue"], fontSize: "10px" },
    { left: 304.0, top: 150.0, width: 0, align: "left" as const, color: "#7E8A93", weight: 500 as const, lines: ["Scout"], fontSize: "11px" },
    { left: 304.0, top: 164.0, width: 0, align: "left" as const, color: "#7E8A93", weight: 400 as const, lines: ["Idle \u00b7 agent"], fontSize: "9px" },
    { left: 123.4, top: 176.0, width: 49, align: "right" as const, color: "#3DCF8E", weight: 500 as const, lines: ["Designer"], fontSize: "11px" },
    { left: 107.0, top: 190.0, width: 66, align: "right" as const, color: "#3DCF8E", weight: 400 as const, lines: ["Live \u00b7 agent"], fontSize: "9px" },
    { left: 84.0, top: 117.0, width: 55, align: "right" as const, color: "#3DCF8E", weight: 400 as const, lines: ["References"], fontSize: "10px" },
    { left: 45.5, top: 156.0, width: 60, align: "right" as const, color: "#3DCF8E", weight: 400 as const, lines: ["Gate frames"], fontSize: "10px" },
    { left: 146.6, top: 273.0, width: 12, align: "right" as const, color: "#7E8A93", weight: 500 as const, lines: ["QA"], fontSize: "11px" },
    { left: 93.0, top: 287.0, width: 66, align: "right" as const, color: "#7E8A93", weight: 400 as const, lines: ["Idle \u00b7 agent"], fontSize: "9px" },
    { left: 205.0, top: 442.0, width: 110, align: "center" as const, color: "#7E8A93", weight: 500 as const, lines: ["COUNCIL \u00b7 EVALUATING"], fontSize: "10px" },
    { left: 97.5, top: 492.0, width: 33, align: "center" as const, color: "#D4A017", weight: 500 as const, lines: ["Seat A"], fontSize: "10px" },
    { left: 70.0, top: 504.0, width: 88, align: "center" as const, color: "#7E8A93", weight: 400 as const, lines: ["reviewing HQ Dev"], fontSize: "9px" },
    { left: 243.5, top: 492.0, width: 33, align: "center" as const, color: "#D4A017", weight: 500 as const, lines: ["Seat B"], fontSize: "10px" },
    { left: 210.5, top: 504.0, width: 99, align: "center" as const, color: "#7E8A93", weight: 400 as const, lines: ["reviewing Designer"], fontSize: "9px" },
    { left: 388.5, top: 492.0, width: 33, align: "center" as const, color: "#3A4550", weight: 500 as const, lines: ["Seat C"], fontSize: "10px" },
    { left: 394.0, top: 504.0, width: 22, align: "center" as const, color: "#7E8A93", weight: 400 as const, lines: ["Wait"], fontSize: "9px" },
  ],
};

export const phoneGraph: GraphModel = {
  width: 390,
  height: 722,
  status: SWARM_STATUS,
  legend: SWARM_LEGEND,
  lines: [],
  nodes: [],
  svgInner: `<circle cx="195" cy="56" r="7" fill="#5EEAD4"/><circle cx="195" cy="56" r="11" fill="none" stroke="#5EEAD4" stroke-width="1" opacity="0.45"/><line x1="195" y1="56" x2="22.0" y2="150" stroke="#3DCF8E" stroke-width="1.5"/><circle cx="22.0" cy="150" r="5.5" fill="#3DCF8E"/><line x1="195" y1="56" x2="79.66666666666666" y2="150" stroke="#3DCF8E" stroke-width="1.5"/><circle cx="79.66666666666666" cy="150" r="5.5" fill="#3DCF8E"/><line x1="195" y1="56" x2="137.33333333333331" y2="150" stroke="#2A333C" stroke-width="1.1"/><circle cx="137.33333333333331" cy="150" r="5.5" fill="#3A4550"/><line x1="195" y1="56" x2="195.0" y2="150" stroke="#D4A017" stroke-width="1.1"/><circle cx="195.0" cy="150" r="5.5" fill="#D4A017"/><line x1="195" y1="56" x2="252.66666666666666" y2="150" stroke="#2A333C" stroke-width="1.1"/><circle cx="252.66666666666666" cy="150" r="5.5" fill="#3A4550"/><circle cx="310.3333333333333" cy="150" r="5" fill="none" stroke="#252C33" stroke-width="1" stroke-dasharray="2 2" opacity="0.55"/><circle cx="368.0" cy="150" r="5" fill="none" stroke="#252C33" stroke-width="1" stroke-dasharray="2 2" opacity="0.55"/><line x1="22.0" y1="158" x2="22.0" y2="230" stroke="#D4A017" stroke-width="1.2"/><circle cx="22.0" cy="230" r="3.5" fill="#D4A017"/><line x1="22.0" y1="230" x2="22.0" y2="278" stroke="#D4A017" stroke-width="1.2"/><circle cx="22.0" cy="278" r="3.5" fill="#D4A017"/><line x1="22.0" y1="278" x2="22.0" y2="326" stroke="#D4A017" stroke-width="1.2"/><circle cx="22.0" cy="326" r="3.5" fill="#D4A017"/><rect x="8.0" y="136" width="28.0" height="204" fill="rgba(61,207,142,0.07)" stroke="#3DCF8E" stroke-width="1" opacity="0.7"/><line x1="79.66666666666666" y1="158" x2="79.66666666666666" y2="230" stroke="#3DCF8E" stroke-width="1.2"/><circle cx="79.66666666666666" cy="230" r="3.5" fill="#3DCF8E"/><line x1="79.66666666666666" y1="230" x2="79.66666666666666" y2="278" stroke="#3DCF8E" stroke-width="1.2"/><circle cx="79.66666666666666" cy="278" r="3.5" fill="#3DCF8E"/><rect x="65.66666666666666" y="136" width="28.0" height="156" fill="rgba(61,207,142,0.07)" stroke="#3DCF8E" stroke-width="1" opacity="0.7"/><line x1="195.0" y1="158" x2="195.0" y2="230" stroke="#D4A017" stroke-width="1.2"/><circle cx="195.0" cy="230" r="3.5" fill="#D4A017"/><rect x="181.0" y="136" width="28.0" height="108" fill="rgba(212,160,23,0.07)" stroke="#D4A017" stroke-width="1" opacity="0.7"/><line x1="24" y1="648" x2="366" y2="648" stroke="#252C33" stroke-width="1" opacity="0.5"/><circle cx="70" cy="612" r="4" fill="#D4A017"/><circle cx="70" cy="612" r="7" fill="none" stroke="#D4A017" stroke-width="1" opacity="0.55"/><line x1="70" y1="606" x2="22.0" y2="178" stroke="#D4A017" stroke-width="1.2" stroke-dasharray="4 3"/><circle cx="195" cy="612" r="4" fill="#D4A017"/><circle cx="195" cy="612" r="7" fill="none" stroke="#D4A017" stroke-width="1" opacity="0.55"/><line x1="195" y1="606" x2="79.66666666666666" y2="178" stroke="#D4A017" stroke-width="1.2" stroke-dasharray="4 3"/><circle cx="320" cy="612" r="4" fill="#3A4550"/><circle cx="320" cy="612" r="7" fill="none" stroke="#3A4550" stroke-width="1" opacity="0.55"/>`,
  labels: [
    { left: 207.0, top: 48.0, width: 0, align: "left" as const, color: "#E6EDF2", weight: 500 as const, lines: ["Dexter"], fontSize: "12px" },
    { left: 207.0, top: 62.0, width: 0, align: "left" as const, color: "#7E8A93", weight: 400 as const, lines: ["CEO / HQ"], fontSize: "9px" },
    { left: 5.5, top: 160.0, width: 33, align: "center" as const, color: "#3DCF8E", weight: 500 as const, lines: ["HQ Dev"], fontSize: "10px" },
    { left: 11.0, top: 172.0, width: 22, align: "center" as const, color: "#3DCF8E", weight: 400 as const, lines: ["Live"], fontSize: "9px" },
    { left: 57.66666666666666, top: 160.0, width: 44, align: "center" as const, color: "#3DCF8E", weight: 500 as const, lines: ["Designer"], fontSize: "10px" },
    { left: 68.66666666666666, top: 172.0, width: 22, align: "center" as const, color: "#3DCF8E", weight: 400 as const, lines: ["Live"], fontSize: "9px" },
    { left: 131.83333333333331, top: 160.0, width: 11, align: "center" as const, color: "#7E8A93", weight: 500 as const, lines: ["QA"], fontSize: "10px" },
    { left: 126.33333333333331, top: 172.0, width: 22, align: "center" as const, color: "#7E8A93", weight: 400 as const, lines: ["Idle"], fontSize: "9px" },
    { left: 178.5, top: 160.0, width: 33, align: "center" as const, color: "#D4A017", weight: 500 as const, lines: ["Barber"], fontSize: "10px" },
    { left: 184.0, top: 172.0, width: 22, align: "center" as const, color: "#D4A017", weight: 400 as const, lines: ["Wait"], fontSize: "9px" },
    { left: 238.91666666666666, top: 160.0, width: 27, align: "center" as const, color: "#7E8A93", weight: 500 as const, lines: ["Scout"], fontSize: "10px" },
    { left: 241.66666666666666, top: 172.0, width: 22, align: "center" as const, color: "#7E8A93", weight: 400 as const, lines: ["Idle"], fontSize: "9px" },
    { left: 307.5833333333333, top: 160.0, width: 5, align: "center" as const, color: "#7E8A93", weight: 400 as const, lines: ["+"], fontSize: "10px" },
    { left: 32.0, top: 224.0, width: 0, align: "left" as const, color: "#D4A017", weight: 400 as const, lines: ["bots table"], fontSize: "10px" },
    { left: 32.0, top: 272.0, width: 0, align: "left" as const, color: "#D4A017", weight: 400 as const, lines: ["Connector"], fontSize: "10px" },
    { left: 32.0, top: 320.0, width: 0, align: "left" as const, color: "#D4A017", weight: 400 as const, lines: ["Vercel cutover"], fontSize: "10px" },
    { left: 89.66666666666666, top: 224.0, width: 0, align: "left" as const, color: "#3DCF8E", weight: 400 as const, lines: ["References"], fontSize: "10px" },
    { left: 89.66666666666666, top: 272.0, width: 0, align: "left" as const, color: "#3DCF8E", weight: 400 as const, lines: ["Gate frames"], fontSize: "10px" },
    { left: 135.5, top: 224.0, width: 49, align: "right" as const, color: "#D4A017", weight: 400 as const, lines: ["Cut queue"], fontSize: "10px" },
    { left: 140.0, top: 584.0, width: 110, align: "center" as const, color: "#7E8A93", weight: 500 as const, lines: ["COUNCIL \u00b7 EVALUATING"], fontSize: "10px" },
    { left: 53.5, top: 624.0, width: 33, align: "center" as const, color: "#D4A017", weight: 500 as const, lines: ["Seat A"], fontSize: "10px" },
    { left: 26.0, top: 636.0, width: 88, align: "center" as const, color: "#7E8A93", weight: 400 as const, lines: ["reviewing HQ Dev"], fontSize: "9px" },
    { left: 178.5, top: 624.0, width: 33, align: "center" as const, color: "#D4A017", weight: 500 as const, lines: ["Seat B"], fontSize: "10px" },
    { left: 145.5, top: 636.0, width: 99, align: "center" as const, color: "#7E8A93", weight: 400 as const, lines: ["reviewing Designer"], fontSize: "9px" },
    { left: 303.5, top: 624.0, width: 33, align: "center" as const, color: "#3A4550", weight: 500 as const, lines: ["Seat C"], fontSize: "10px" },
    { left: 309.0, top: 636.0, width: 22, align: "center" as const, color: "#7E8A93", weight: 400 as const, lines: ["Wait"], fontSize: "9px" },
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
    { cx: 480, cy: 430, r: 4.5, fill: HUB },
    { cx: 608.7, cy: 322.01, r: 3.5, fill: LIVE },
    { cx: 728.2, cy: 221.74, r: 3.5, fill: FORMING },
  ],
  labels: [
    { left: 492.5, top: 423.5, width: 34, align: "left", color: INK, weight: 500, lines: ["Dexter"] },
    { left: 588.7, top: 333.51, width: 40, align: "center", color: LIVE, weight: 400, lines: ["HQ Dev"] },
    { left: 739.7, top: 215.24, width: 107, align: "left", color: FORMING, weight: 400, lines: ["Point production at v5"] },
  ],
};
