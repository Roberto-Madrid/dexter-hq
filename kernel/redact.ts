import { ruleRegExp, SECRET_RULES } from "./patterns.ts";

export function redact(text: string): string {
  let out = text;
  for (const rule of SECRET_RULES) {
    out = out.replace(ruleRegExp(rule), "[redacted]");
  }
  return out;
}
