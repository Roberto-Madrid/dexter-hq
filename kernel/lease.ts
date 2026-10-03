export class StaleGeneration extends Error {
  constructor() {
    super("stale_generation");
    this.name = "StaleGeneration";
  }
}

export function assertFresh(current: number, expected: number): void {
  if (current !== expected) throw new StaleGeneration();
}

export function nextGeneration(current: number): number {
  return current + 1;
}

export function leaseExpired(untilIso: string, nowIso: string): boolean {
  return Date.parse(untilIso) <= Date.parse(nowIso);
}
