export type ChatResult = {
  kind: "status" | "cost" | "list" | "plan" | "hold";
  text: string;
  modelCalls: number;
  card: {
    crew: string;
    personas: string[];
    councilMode: string;
    tier: string;
    definitionOfDone: string;
    outOfScope: string;
    needsOwner: string[];
    newScreen: boolean;
    outwardAction: boolean;
    requiresDesignApproval: boolean;
    requiresApproval: boolean;
  } | null;
  notices: string[];
  requestId: string | null;
  asOf: string;
};

export type BoardSnapshot = {
  asOf: string;
  slotsUsed: number;
  slotCap: number;
  spend: "unknown";
  quotas: "unknown";
  columns: {
    needsYou: UiCard[];
    active: UiCard[];
    queued: UiCard[];
    done: UiCard[];
  };
  swarm: { id: string; persona: string; state: string; model: string | null; pool: string | null; routingReason: string | null }[];
  messages: { role: string; body: string; at: string }[];
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

export function login(email: string, secure: boolean, now?: number): { ok: true; token: string; cookie: string } | { ok: false; status: number };
export function emailFromCookie(header: string | null, now?: number): string | null;
export function postChat(
  text: string,
  onDelta?: (delta: string) => void,
): Promise<
  ChatResult & {
    billing?: "chatgpt-plan";
    trace: { stages: Record<string, number>; model: string | null; effort: string | null; loginHashChanged: boolean };
  }
>;
export function getBoard(): Promise<BoardSnapshot>;
export function postStop(): Promise<{ reports: { id: string; runtime: string; state: string }[]; asOf: string }>;
export function postResume(): Promise<{ resumed: boolean; asOf: string }>;
export function postTick(header: string | null): Promise<{ status: number; body?: unknown }>;
export function postCallback(raw: string, signature: string | null): Promise<{ status: number; duplicate?: boolean }>;
