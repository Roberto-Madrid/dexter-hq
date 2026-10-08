import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bundledPersonas } from "./bundled-assets.ts";

const ROLE_PERSONA: Record<string, string> = {
  builder: "builder",
  quick_edit: "builder",
  data: "builder",
  contracts: "builder",
  researcher: "researcher",
  career: "career",
  qa: "qa",
  qa_visual: "qa",
  designer: "designer",
  writer: "writer",
  security: "security",
  architect: "writer",
  strategist: "writer",
  venture: "venture",
  ceo: "dexter",
};

const PERSONA_LIMIT = 2000;

function personasFrom(entries: Iterable<[string, string]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, text] of entries) {
    if (!name.endsWith(".md")) continue;
    map.set(name.replace(/\.md$/, ""), text.trim());
  }
  return map;
}

export function loadPersonas(dir = "personas"): Map<string, string> {
  try {
    const entries: [string, string][] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      entries.push([name, readFileSync(join(dir, name), "utf8")]);
    }
    return personasFrom(entries);
  } catch (error) {
    const bundled = bundledPersonas();
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && bundled) {
      return personasFrom(Object.entries(bundled));
    }
    throw error;
  }
}

export function personaIdForRole(role: string): string | null {
  return ROLE_PERSONA[role] ?? (loadPersonas().has(role) ? role : null);
}

export function composeLaunchBrief(role: string, brief: string, personas = loadPersonas()): {
  text: string;
  persona: string | null;
} {
  const id = personaIdForRole(role);
  const body = id ? personas.get(id) : undefined;
  if (!id || !body) return { text: brief, persona: null };
  const contract = body.slice(0, PERSONA_LIMIT);
  return {
    persona: id,
    text: `Persona contract (${id}):\n${contract}\n\nBrief:\n${brief}`,
  };
}
