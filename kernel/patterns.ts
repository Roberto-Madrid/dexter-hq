export type TextRule = { id: string; source: string; flags: string };

export const SECRET_RULES: readonly TextRule[] = [
  { id: "sk", source: "\\bsk-[A-Za-z0-9]{16,}\\b", flags: "g" },
  { id: "ghp", source: "\\bghp_[A-Za-z0-9]{20,}\\b", flags: "g" },
  { id: "akia", source: "\\bAKIA[0-9A-Z]{16}\\b", flags: "g" },
  { id: "private_key", source: "-----BEGIN [A-Z ]*PRIVATE KEY-----", flags: "g" },
  { id: "slack", source: "\\bxox[baprs]-[A-Za-z0-9-]{10,}", flags: "g" },
  { id: "age", source: "\\bAGE-SECRET-KEY-1[A-Z2-7]{20,}\\b", flags: "g" },
];

export const DESTRUCTIVE_RULES: readonly TextRule[] = [
  { id: "rm-rf", source: "\\brm\\s+-[a-zA-Z]*r[a-zA-Z]*f|\\brm\\s+-[a-zA-Z]*f[a-zA-Z]*r", flags: "i" },
  { id: "drop", source: "\\bdrop\\s+(database|table|schema)\\b", flags: "i" },
  { id: "force-push", source: "\\bgit\\s+push\\b[^\\n]*--force\\b", flags: "i" },
  { id: "reset-hard", source: "\\bgit\\s+reset\\s+--hard\\b", flags: "i" },
  { id: "mkfs", source: "\\bmkfs(?:\\.[a-z0-9]+)?\\b", flags: "i" },
  { id: "truncate", source: "\\btruncate\\s+table\\b", flags: "i" },
];

export function ruleRegExp(rule: TextRule): RegExp {
  return new RegExp(rule.source, rule.flags);
}

export function matchingRules(text: string, rules: readonly TextRule[]): string[] {
  const hits: string[] = [];
  for (const rule of rules) {
    if (ruleRegExp(rule).test(text)) hits.push(rule.id);
  }
  return hits;
}
