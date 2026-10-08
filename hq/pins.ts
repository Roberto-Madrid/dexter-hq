// Red-commit stub: the daily version check is not built yet. The U2 green commit replaces this file.
export const PIN_FAILURE_RETRY_MS = 60 * 60 * 1000;

export async function resolveDailyPins(_input: unknown): Promise<{ configured: boolean; owners: Record<string, unknown>[] }> {
  throw new Error("not_implemented");
}

export async function connectorTick(_deps: unknown, _sheetText: string): Promise<never> {
  throw new Error("not_implemented");
}
