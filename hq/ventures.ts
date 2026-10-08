// Stage 3 unit 3: Add-venture backend. Red-phase stub: the tests describe the behavior before it exists.
import type { ConnectorStore } from "./connector-store.ts";

export const LEAD_SCOPES: readonly string[] = [];

export type RepoCheckResult = "reachable" | "not_reachable" | "unavailable";
export type RepoCheck = (repo: string) => Promise<RepoCheckResult>;

export type VenturesDeps = {
  store: ConnectorStore;
  repoCheck: RepoCheck;
  ownerFromCookie: (cookieHeader: string | null) => string | null;
  now?: () => Date;
};

export function heartbeatStatus(
  _input: { heartbeatAt: string | null; tokenIssuedAt: string | null },
  _now: Date,
): { status: "live" | "wait" | "never_seen"; heartbeatAgeSeconds: number | null } {
  throw new Error("not_implemented");
}

export function createGhRepoCheck(_options: {
  token: string | undefined;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}): RepoCheck {
  return async () => {
    throw new Error("not_implemented");
  };
}

export async function handleVenturesHttp(_request: Request, _deps: VenturesDeps): Promise<Response> {
  return new Response("not implemented", { status: 501 });
}
