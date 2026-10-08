// Red-phase stub for Stage 3 unit 6.
import type { ConnectorStore } from "./connector-store.ts";

export const SELFTEST_CHECKS: readonly string[] = [];
export type SelftestCheck = { name: string; ok: boolean; detail: string };
export type SelftestRecord = { day: string; at: string; ok: boolean; failed: string[]; checks: SelftestCheck[] };
export interface SelftestDb {
  ping(): Promise<void>;
  controlRows(): Promise<boolean[]>;
  tokenSuspension(): Promise<{ total: number; suspended: number }>;
  tickStats(since: string): Promise<{ lastBeatAt: string | null; maxGapSeconds: number | null }>;
  hasRun(day: string, dayStart: string): Promise<boolean>;
  latest(): Promise<SelftestRecord | null>;
  recordOnce(record: SelftestRecord): Promise<boolean>;
}
export type SelftestHealth = {
  ok: boolean;
  tickAgeSeconds: number | null;
  selfTestDay: string | null;
  selfTestOk: boolean | null;
  selfTestAgeHours: number | null;
  reasons: string[];
};
export async function runDailySelftest(_input: {
  db: SelftestDb;
  connector: ConnectorStore;
  env: Record<string, string | undefined>;
  now: Date;
  sheetText?: string;
}): Promise<Record<string, unknown>> {
  throw new Error("not_implemented");
}
export function isSelftestQuestion(_text: string): boolean {
  throw new Error("not_implemented");
}
export async function selftestChatAnswer(_db: SelftestDb | undefined, _now: Date): Promise<string> {
  throw new Error("not_implemented");
}
export async function selftestHealth(_db: SelftestDb, _now: Date): Promise<SelftestHealth> {
  throw new Error("not_implemented");
}
export function alertApprovalId(_day: string): string {
  throw new Error("not_implemented");
}
export async function runSelftestChecks(_input: {
  db: SelftestDb;
  connector: ConnectorStore;
  env: Record<string, string | undefined>;
  now: Date;
  sheetText?: string;
  day: string;
}): Promise<SelftestRecord> {
  throw new Error("not_implemented");
}
