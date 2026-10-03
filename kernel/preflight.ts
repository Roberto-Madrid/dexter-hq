import { DESTRUCTIVE_RULES, matchingRules, SECRET_RULES } from "./patterns.ts";

export type PreflightFinding = {
  kind: "secret" | "destructive" | "unknown_url";
  rule: string;
};

const URL_RE = /\bhttps?:\/\/[^\s)>\]]+/gi;

function hostOf(raw: string): string | null {
  try {
    return new URL(raw.replace(/[.,;]+$/, "")).host.toLowerCase();
  } catch {
    return null;
  }
}

export function preflight(text: string, knownHosts: readonly string[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const rule of matchingRules(text, SECRET_RULES)) {
    findings.push({ kind: "secret", rule });
  }
  for (const rule of matchingRules(text, DESTRUCTIVE_RULES)) {
    findings.push({ kind: "destructive", rule });
  }
  const allowed = new Set(knownHosts.map((host) => host.toLowerCase()));
  const seen = new Set<string>();
  for (const match of text.match(URL_RE) ?? []) {
    const host = hostOf(match);
    if (!host || allowed.has(host) || seen.has(host)) continue;
    seen.add(host);
    findings.push({ kind: "unknown_url", rule: host });
  }
  return findings;
}
