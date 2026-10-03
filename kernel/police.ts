export const SANDBOX_SLOT_CAP = 3;
export const PAUSE_RATIO = 0.8;

export function reserveSlot(
  active: number,
  cap = SANDBOX_SLOT_CAP,
): { ok: boolean; active: number } {
  if (active >= cap) return { ok: false, active };
  return { ok: true, active: active + 1 };
}

export function reservePoolRun(reserved: number, cap: number): { ok: boolean; reserved: number } {
  if (cap < 1 || reserved >= cap) return { ok: false, reserved };
  return { ok: true, reserved: reserved + 1 };
}

export function charge(
  used: number,
  cost: number,
  cap: number,
): { allowed: boolean; used: number } {
  const next = used + cost;
  if (next > cap) return { allowed: false, used };
  return { allowed: true, used: next };
}

export function shouldPause(used: number, cap: number, hasArtifact: boolean): boolean {
  if (cap <= 0) return true;
  return !hasArtifact && used / cap >= PAUSE_RATIO;
}

export function substantiveRetryAllowed(usedRetries: number): boolean {
  return usedRetries < 1;
}

export function nextPool(order: readonly string[], exhausted: ReadonlySet<string>): string | null {
  for (const pool of order) {
    if (!exhausted.has(pool)) return pool;
  }
  return null;
}
