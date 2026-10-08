import type { ModelRow, RoleSheet, Runtime } from "../kernel/types.ts";
import type { ConnectorStore } from "./connector-store.ts";
import type { FleetReportStore } from "./fleet-report.ts";
import type { CeoClient } from "./scripted-ceo.ts";

export type ListedRuntime = Runtime & {
  listInProgress(): Promise<{ id: string; runtime: string }[]>;
};

export type HqDeps = {
  ceo: CeoClient;
  ceoEnabled: boolean;
  sheet: RoleSheet;
  catalog: readonly ModelRow[];
  shippedCrews: readonly string[];
  exhaustedPools: readonly string[];
  knownHosts: readonly string[];
  slotCap: number;
  runtimes: Record<string, ListedRuntime>;
  controlReachable: boolean;
  connector?: ConnectorStore;
  fleetReports?: FleetReportStore;
};

export function runtimeNameForPool(pool: string): string | null {
  if (pool === "cursor") return "cursor-cloud";
  if (pool === "codex") return "gh-runner";
  return null;
}
