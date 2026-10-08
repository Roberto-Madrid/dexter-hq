// Red-phase stub: names only, no behavior. Replaced by the implementation in the next commit.
import type { ConnectorAgent } from "./connector-store.ts";
export const SANDBOX_ENV = "DEXTER_UPGRADE_SANDBOX_REPO";
export const UPGRADE_CHECK_STARTED = "upgrade_check_started";
export const UPGRADE_CHECK_DONE = "upgrade_check_done";
export const UPGRADE_ROLLBACK_ACTION = "upgrade_rollback";
export const COUNCIL_UPGRADE_ACTION = "council_upgrade";
export type UpgradeTickResult = { checks: { status: string; [key: string]: unknown }[] };
export function loadUpgradeTasks(_family: string): { id: string; brief: string }[] {
  return [];
}
export function upgradeRunKey(_family: string, _version: string, _task: string): string {
  return "";
}
export async function defaultUpgradeGrader(_agent: ConnectorAgent): Promise<{ passed: boolean; checksFailed: number } | null> {
  return null;
}
export async function advanceUpgradeChecks(_input: Record<string, unknown>): Promise<UpgradeTickResult> {
  return { checks: [] };
}
