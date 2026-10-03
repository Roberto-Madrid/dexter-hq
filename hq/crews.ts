import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { bundledCrews } from "./bundled-assets.ts";

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

function crewsFrom(entries: Iterable<[string, string]>): Map<string, CrewFile> {
  const crews = new Map<string, CrewFile>();
  for (const [name, text] of entries) {
    if (!name.endsWith(".yaml")) continue;
    const raw = parse(text) as RawCrew;
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

export function loadCrews(dir = "crews"): Map<string, CrewFile> {
  try {
    const entries: [string, string][] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".yaml")) continue;
      entries.push([name, readFileSync(join(dir, name), "utf8")]);
    }
    return crewsFrom(entries);
  } catch (error) {
    const bundled = bundledCrews();
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && bundled) return crewsFrom(Object.entries(bundled));
    throw error;
  }
}

export function isQuickEdit(text: string): boolean {
  return /\b(rename|typo|label|copy|comment)\b/i.test(text) && !/\b(auth|payment|migration|secret)\b/i.test(text);
}
