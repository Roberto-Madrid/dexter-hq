import { readFileSync } from "node:fs";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import type { RunSpec } from "../../kernel/types.ts";
import {
  CONNECTOR_TOOLS,
  callConnectorTool,
  createDefaultConnectorDeps,
  createMemoryConnectorStore,
  type ConnectorDeps,
  type CursorGateway,
} from "../../hq/connector.ts";
import type { ConnectorAuth } from "../../hq/connector-store.ts";

export const sheet = parseRoleSheet(readFileSync("gateway/role-sheet.yaml", "utf8"));
export const OWNER = "11111111-1111-4111-8111-111111111111";
export const BOT = "22222222-2222-4222-8222-222222222222";
export const REPOS = ["owner/a", "owner/b", "owner/c", "owner/d"];

const auth: ConnectorAuth = {
  id: BOT,
  ownerId: OWNER,
  name: "unit-lead",
  kind: "lead",
  repos: REPOS,
  tools: [...CONNECTOR_TOOLS],
  currentTask: null,
  heartbeatAt: null,
  scopes: [...CONNECTOR_TOOLS],
  suspended: false,
};

export type FakeCursor = CursorGateway & { starts: RunSpec[]; states: Map<string, string>; followups: string[] };

export function fakeCursor(options?: { delayMs?: number; failStart?: boolean; failFollowup?: boolean }): FakeCursor {
  const starts: RunSpec[] = [];
  const states = new Map<string, string>();
  const followups: string[] = [];
  let count = 0;
  return {
    starts,
    states,
    followups,
    async start(spec) {
      starts.push(spec);
      count += 1;
      const id = `bc-${count}:run-${count}`;
      if (options?.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options?.failStart) throw new Error("start_failed");
      states.set(id, "RUNNING");
      return { id, runtime: "cursor-cloud" };
    },
    async status(handle) {
      return { state: states.get(handle.id) ?? "unknown", usage: {} };
    },
    async cancel() {
      return { state: "confirmed" };
    },
    async collect() {
      return [];
    },
    async followup(handle) {
      followups.push(handle.id);
      if (options?.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options?.failFollowup) throw new Error("followup_failed");
      count += 1;
      const id = `${handle.id.split(":")[0]}:run-${count}`;
      states.set(id, "RUNNING");
      return { id, runtime: "cursor-cloud" };
    },
  };
}

export async function capsDeps(options?: {
  cursor?: FakeCursor;
  stopped?: boolean;
  runCouncilSeat?: ConnectorDeps["runCouncilSeat"];
  now?: () => string;
}) {
  const store = createMemoryConnectorStore({ stopped: options?.stopped, bots: [auth] });
  for (const [index, repo] of REPOS.entries()) {
    for (let n = 0; n < 8; n += 1) {
      await store.saveRequest({
        id: `req-${index}-${n}`,
        ownerId: OWNER,
        goal: "Change one label.",
        status: "queued",
        card: { crew: "change", newScreen: false, requiresDesignApproval: false },
        evidence: [],
        assignedBotId: BOT,
        repo,
        notices: [],
      });
    }
  }
  const cursor = options?.cursor ?? fakeCursor();
  const deps = createDefaultConnectorDeps({
    store,
    sheet,
    cursor,
    cursorConfigured: true,
    checker: null,
    ownerId: OWNER,
    councilConfigured: Boolean(options?.runCouncilSeat),
    runCouncilSeat: options?.runCouncilSeat,
    now: options?.now,
  });
  return { deps, store, cursor };
}

export function launch(deps: ConnectorDeps, key: string, repo = "owner/a", requestId?: string, extra?: Record<string, unknown>) {
  const index = REPOS.indexOf(repo);
  return callConnectorTool(deps, auth, "launch_agent", {
    role: "builder",
    brief: "Change one label in the footer.",
    idempotencyKey: key,
    repo,
    requestId: requestId ?? `req-${index}-${key.length % 8}`,
    ...extra,
  });
}

export { auth as capsAuth };
