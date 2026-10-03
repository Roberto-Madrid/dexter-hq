export type ChatResult = {
  kind: "status" | "cost" | "list" | "plan" | "hold";
  text: string;
  modelCalls: number;
  card: { crew: string } | null;
  notices: string[];
  requestId: string | null;
  asOf: string;
};

export type UiCard = {
  id: string;
  title: string;
  crew: string;
  tier: string;
  stage: string;
  personas: string[];
  updatedAt: string;
  evidenceAt: string | null;
  tasksDone: number;
  tasksTotal: number;
  usageByPool: Record<string, number>;
  blocker: string | null;
  badges: string[];
  model: string | null;
  pool: string | null;
  routingReason: string | null;
};

export type BoardSnapshot = {
  asOf: string;
  slotsUsed: number;
  slotCap: number;
  spend: "unknown";
  quotas: "unknown";
  columns: { needsYou: UiCard[]; active: UiCard[]; queued: UiCard[]; done: UiCard[] };
  swarm: { id: string; persona: string; state: string; model: string | null; pool: string | null; routingReason: string | null }[];
  messages: { role: string; body: string; at: string }[];
};
