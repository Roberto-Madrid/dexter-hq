import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const SHIPPED_CREWS = ["answer", "research", "change", "custom"] as const;

export type CrewTask = {
  persona: string;
  role: string;
  artifact: string;
  dependsOn: string[];
};

export type CrewFile = {
  name: string;
  tasks: CrewTask[];
};

type RawTask = { persona?: string; role?: string; artifact?: string; depends_on?: string | string[] };
type RawCrew = { name?: string; tasks?: RawTask[] };

export function loadCrews(dir = "crews"): Map<string, CrewFile> {
  const crews = new Map<string, CrewFile>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".yaml")) continue;
    const raw = parse(readFileSync(join(dir, name), "utf8")) as RawCrew;
    const tasks = (raw.tasks ?? []).map((task) => ({
      persona: String(task.persona ?? ""),
      role: String(task.role ?? ""),
      artifact: String(task.artifact ?? ""),
      dependsOn: Array.isArray(task.depends_on) ? task.depends_on : task.depends_on ? [task.depends_on] : [],
    }));
    crews.set(String(raw.name ?? name.replace(/\.yaml$/, "")), { name: String(raw.name), tasks });
  }
  return crews;
}

export function isQuickEdit(text: string): boolean {
  return /\b(rename|typo|label|copy|comment)\b/i.test(text) && !/\b(auth|payment|migration|secret)\b/i.test(text);
}
