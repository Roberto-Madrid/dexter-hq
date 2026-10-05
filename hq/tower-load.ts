import { createPgConnectorStore } from "./connector-pg.ts";
import type { ConnectorStore } from "./connector-store.ts";
import {
  assembleTower,
  exampleTowerSnapshot,
  type ConnectorLive,
  type CursorLive,
  type TowerSnapshot,
} from "../app/(hq)/tower-model.ts";

export type TowerLoadOptions = {
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  readConnector?: () => Promise<ConnectorLive | null>;
  readCursor?: () => Promise<CursorLive | null>;
};

async function optional<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

async function readConnectorStore(store: ConnectorStore): Promise<ConnectorLive> {
  const [bots, requests, approvals, events, agents, stopped] = await Promise.all([
    optional(() => store.listBots()),
    optional(() => store.listRequests()),
    optional(() => store.listApprovals()),
    optional(() => store.listEvents()),
    optional(() => store.listAgents()),
    optional(() => store.stopped()),
  ]);
  return { bots, requests, approvals, events, agents, stopped: stopped ?? false };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function readCursorFromKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<CursorLive | null> {
  const response = await fetchImpl("https://api.cursor.com/v1/agents", {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return null;
  const body = asRecord(await response.json().catch(() => null));
  const list = body.agents ?? body.items ?? [];
  if (!Array.isArray(list)) return { runs: [], usageText: null };
  return {
    runs: list.map((item) => {
      const row = asRecord(item);
      const id = String(row.id ?? "");
      const runId = String(row.runId ?? row.id ?? "");
      return {
        id: id && runId ? `${id}:${runId}` : id || runId,
        name: typeof row.name === "string" ? row.name : undefined,
        status: typeof row.status === "string" ? row.status : undefined,
      };
    }),
    usageText: null,
  };
}

export async function loadTowerSnapshot(options: TowerLoadOptions = {}): Promise<TowerSnapshot> {
  const env = options.env ?? process.env;
  const db = env.SUPABASE_DB_URL?.trim() ?? "";
  const cursorKey = env.CURSOR_API_KEY?.trim() ?? "";
  if (!db && !cursorKey && !options.readConnector && !options.readCursor) {
    return exampleTowerSnapshot();
  }

  let connector: ConnectorLive | null = null;
  try {
    connector = options.readConnector
      ? await options.readConnector()
      : db
        ? await readConnectorStore(createPgConnectorStore(db))
        : null;
  } catch {
    connector = null;
  }

  let cursor: CursorLive | null = null;
  try {
    cursor = options.readCursor ? await options.readCursor() : cursorKey ? await readCursorFromKey(cursorKey) : null;
  } catch {
    cursor = null;
  }

  return assembleTower({
    nowMs: options.nowMs ?? Date.now(),
    connector,
    cursor,
  });
}
