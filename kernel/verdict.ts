import type { Verdict } from "./types.ts";

const RANK = { pass: 0, changes: 1, discuss: 2 } as const;

export function mergeVerdicts(parts: readonly Verdict[]): Verdict {
  if (parts.length === 0) return { result: "pass", actions: [] };
  let result: Verdict["result"] = "pass";
  const actions: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (RANK[part.result] > RANK[result]) result = part.result;
    for (const action of part.actions) {
      if (seen.has(action)) continue;
      seen.add(action);
      actions.push(action);
    }
  }
  return { result, actions };
}
