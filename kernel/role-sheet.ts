import { parse } from "yaml";
import { RoleSheetSchema } from "./schemas.ts";
import type { ModelRow, RoleSheet, RoutingDecision, Sensitivity } from "./types.ts";

const STANDARD = "standard";

export type CurrentResolution = {
  family: string;
  version: string;
  pricePerToken: number;
};

export type ResolveInput = {
  sheet: RoleSheet;
  catalog: readonly ModelRow[];
  current?: readonly CurrentResolution[];
  role: string;
  quickEdit?: boolean;
  change?: { lines: number; paths: string[] };
  failedChecks?: number;
  sensitivity?: Sensitivity;
  makerFamily?: string | null;
  council?: boolean;
  exhaustedPools?: readonly string[];
};

type Block = "model_missing" | "price_or_variant" | "privacy";

export function sheetFamilies(sheet: RoleSheet): Set<string> {
  const families = new Set<string>([sheet.ceo.family, ...sheet.councilFamilies]);
  for (const binding of Object.values(sheet.roles)) families.add(binding.family);
  for (const ladder of Object.values(sheet.escalation.ladders)) {
    for (const family of ladder) families.add(family);
  }
  return families;
}

export function capForPool(sheet: RoleSheet, pool: string): number | null {
  const caps = Object.values(sheet.roles)
    .filter((binding) => binding.pool === pool && binding.weeklyRunCap !== undefined)
    .map((binding) => binding.weeklyRunCap as number);
  if (caps.length === 0) return null;
  return Math.min(...caps);
}

export function parseRoleSheet(text: string): RoleSheet {
  const raw = parse(text) as Record<string, unknown>;
  const ceo = raw.ceo as Record<string, string>;
  const roles = raw.roles as Record<string, Record<string, unknown>>;
  const escalation = raw.escalation as Record<string, unknown>;
  const ladders: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(escalation)) {
    if (key === "after_failed_checks") continue;
    ladders[key] = value as string[];
  }
  const policy = raw.version_policy as { variant: string; price_guard: string };
  const quick = raw.quick_edit_rule as { max_changed_lines: number; excluded_paths: string[] };
  const council = raw.council as { families: string[] };
  return RoleSheetSchema.parse({
    version: raw.version,
    ceo: {
      family: ceo.family,
      reasoningEffort: ceo.reasoning_effort,
      pool: ceo.pool,
      onUnavailable: ceo.on_unavailable,
    },
    roles: Object.fromEntries(
      Object.entries(roles).map(([name, binding]) => [
        name,
        {
          family: binding.family,
          pool: binding.pool,
          ...(binding.reasoning_effort ? { reasoningEffort: binding.reasoning_effort } : {}),
          ...(binding.weekly_run_cap ? { weeklyRunCap: binding.weekly_run_cap } : {}),
        },
      ]),
    ),
    councilFamilies: council.families,
    poolOrder: raw.pool_order,
    quickEditRule: {
      maxChangedLines: quick.max_changed_lines,
      excludedPaths: quick.excluded_paths,
    },
    escalation: {
      afterFailedChecks: escalation.after_failed_checks,
      ladders,
    },
    versionPolicy: { variant: policy.variant, priceGuard: policy.price_guard },
  });
}

function hold(
  role: string,
  family: string | null,
  alert: string,
  escalation: RoutingDecision["escalation"],
): RoutingDecision {
  return {
    status: "hold",
    held: true,
    role,
    family,
    version: null,
    modelRowId: null,
    pool: null,
    routingReason: alert,
    alert,
    escalation,
  };
}

function resolved(
  role: string,
  row: ModelRow,
  reason: string,
  escalation: RoutingDecision["escalation"],
): RoutingDecision {
  return {
    status: "resolved",
    held: false,
    role,
    family: row.family,
    version: row.version,
    modelRowId: row.id,
    pool: row.pool,
    routingReason: escalation ? `${reason}+escalation` : reason,
    alert: null,
    escalation,
  };
}

function qualifiesAsQuick(sheet: RoleSheet, change: { lines: number; paths: string[] } | undefined): boolean {
  if (!change) return true;
  if (change.lines > sheet.quickEditRule.maxChangedLines) return false;
  return !change.paths.some((path) =>
    sheet.quickEditRule.excludedPaths.some((fragment) => path.includes(fragment)),
  );
}

function bestRow(
  catalog: readonly ModelRow[],
  family: string,
  pool: string,
  current: CurrentResolution | undefined,
  sensitivity: Sensitivity,
): { row: ModelRow | null; block: Block } {
  const samePool = catalog.filter((row) => row.family === family && row.pool === pool && row.available);
  if (samePool.length === 0) return { row: null, block: "model_missing" };
  const standard = samePool.filter((row) => row.variant.toLowerCase() === STANDARD);
  if (standard.length === 0) return { row: null, block: "price_or_variant" };
  const priced = current
    ? standard.filter((row) => row.pricePerToken <= current.pricePerToken)
    : standard;
  if (priced.length === 0) return { row: null, block: "price_or_variant" };
  const allowed = priced.filter(
    (row) => !(sensitivity !== "none" && row.trainsOnPrompts),
  );
  if (allowed.length === 0) return { row: null, block: "privacy" };
  allowed.sort((a, b) => (a.releasedAt < b.releasedAt ? 1 : -1));
  return { row: allowed[0] ?? null, block: "model_missing" };
}

function currentFor(current: readonly CurrentResolution[], family: string): CurrentResolution | undefined {
  return current.find((row) => row.family === family);
}

export function resolveRouting(input: ResolveInput): RoutingDecision {
  const sheet = input.sheet;
  const families = sheetFamilies(sheet);
  const sensitivity = input.sensitivity ?? "none";
  const current = input.current ?? [];
  const exhausted = new Set(input.exhaustedPools ?? []);
  const failedChecks = input.failedChecks ?? 0;

  if (input.role === "ceo") return resolveCeo(input, families, sensitivity, current);

  if (input.council) {
    const family = sheet.councilFamilies.find((item) => item !== input.makerFamily) ?? null;
    if (!family || !families.has(family)) return hold(input.role, family, "model_missing", null);
    const pool = sheet.poolOrder.find((item) => !exhausted.has(item));
    if (!pool) return hold(input.role, family, "pools_exhausted", null);
    const pick = bestRow(input.catalog, family, pool, currentFor(current, family), sensitivity);
    if (!pick.row || !families.has(pick.row.family)) return hold(input.role, family, pick.block, null);
    return resolved(input.role, pick.row, "council", null);
  }

  const quick =
    input.quickEdit === true &&
    input.role !== "ceo" &&
    qualifiesAsQuick(sheet, input.change) &&
    sheet.roles.quick_edit !== undefined;
  const roleKey = quick ? "quick_edit" : input.role;
  const binding = sheet.roles[roleKey];
  if (!binding) return hold(input.role, null, "unknown_role", null);

  let family = binding.family;
  let escalation: RoutingDecision["escalation"] = null;
  const ladder = quick ? sheet.escalation.ladders.quick_edit : sheet.escalation.ladders[input.role];
  if (ladder && failedChecks >= sheet.escalation.afterFailedChecks) {
    const step = Math.min(
      Math.floor(failedChecks / sheet.escalation.afterFailedChecks),
      ladder.length - 1,
    );
    const next = ladder[step] ?? family;
    if (step > 0 && next !== family) {
      escalation = { from: family, to: next, failedChecks };
      family = next;
    }
  }
  if (!families.has(family)) return hold(input.role, null, "off_sheet", escalation);

  const preferred = binding.pool;
  const pick = bestRow(input.catalog, family, preferred, currentFor(current, family), sensitivity);
  if (pick.row && families.has(pick.row.family) && !exhausted.has(preferred)) {
    return resolved(input.role, pick.row, "role_pool", escalation);
  }
  if (!exhausted.has(preferred)) {
    return hold(input.role, family, pick.block, escalation);
  }

  const start = Math.max(sheet.poolOrder.indexOf(preferred), 0);
  for (const pool of sheet.poolOrder.slice(start + 1)) {
    if (exhausted.has(pool)) continue;
    const same = bestRow(input.catalog, family, pool, currentFor(current, family), sensitivity);
    if (same.row && families.has(same.row.family)) {
      return resolved(input.role, same.row, "pool_fallback", escalation);
    }
    const fallback = Object.values(sheet.roles).find((item) => item.pool === pool);
    if (!fallback || !families.has(fallback.family)) continue;
    const other = bestRow(
      input.catalog,
      fallback.family,
      pool,
      currentFor(current, fallback.family),
      sensitivity,
    );
    if (other.row && families.has(other.row.family)) {
      return resolved(input.role, other.row, "pool_fallback", escalation);
    }
  }
  return hold(input.role, family, "pools_exhausted", escalation);
}

function resolveCeo(
  input: ResolveInput,
  families: Set<string>,
  sensitivity: Sensitivity,
  current: readonly CurrentResolution[],
): RoutingDecision {
  const family = input.sheet.ceo.family;
  if (!families.has(family)) return hold("ceo", null, "off_sheet", null);
  const pick = bestRow(
    input.catalog,
    family,
    input.sheet.ceo.pool,
    currentFor(current, family),
    sensitivity,
  );
  if (!pick.row || pick.row.family !== family) {
    return hold("ceo", family, pick.row ? "off_sheet" : input.sheet.ceo.onUnavailable, null);
  }
  return resolved("ceo", pick.row, "ceo", null);
}
