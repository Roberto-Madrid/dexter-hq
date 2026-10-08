import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { readCatalogMatch } from "../gateway/catalog.ts";
import type { HandoffDestination, HandoffInput, HandoffSource, HandoffTask } from "../kernel/handoff-bundle.ts";
import { parseRoleSheet, sheetFamilies } from "../kernel/role-sheet.ts";

export const HANDOFF_CREW = "handoff";

/** Where each bundle section comes from in a checkout of this repo. */
export const HANDOFF_SOURCES = {
  charter: "AGENTS.md",
  architecture: "README.md",
  runbook: ["ops/README-watchdog.md", "ops/README-checker.md", "docs/LOCAL_BOOT.md"],
  // dexter-shortcut: no dedicated deployment doc yet, so the production tick wiring stands in; upgrade path: point this
  // at a docs/DEPLOY.md that covers the hosting project, migrations, and edge functions.
  deployment: "ops/README-tick.md",
} as const;

/** Code scanned for shortcut markers. Tests, docs, and generated bundles are not debt. */
const SHORTCUT_DIRS = ["hq", "kernel", "app", "gateway", "adapters", "scripts", "supabase/functions"];
const SHORTCUT_SKIP = /(?:^|\/)(?:node_modules|generated|_shared)(?:\/|$)/;
const SHORTCUT_EXT = /\.(?:ts|tsx|js|mjs|sh|sql)$/;
/** The package.json scripts a maintainer runs before merging, in order. */
const DONE_SCRIPTS = ["typecheck", "lint", "test", "check:vendor", "check:briefs", "check:bundle", "scan:secrets", "test:integration"];

function read(root: string, path: string): HandoffSource {
  return { path, text: readFileSync(join(root, path), "utf8") };
}

function walk(root: string, dir: string, out: HandoffSource[]): void {
  const full = join(root, dir);
  if (!existsSync(full)) return;
  for (const name of readdirSync(full).sort()) {
    const path = join(full, name);
    const rel = relative(root, path).split("\\").join("/");
    if (SHORTCUT_SKIP.test(rel)) continue;
    if (statSync(path).isDirectory()) walk(root, rel, out);
    else if (SHORTCUT_EXT.test(name)) out.push({ path: rel, text: readFileSync(path, "utf8") });
  }
}

/**
 * Reads the bundle's sources from a checkout. `knownIssues` and `openTasks` come from the caller (the board), since
 * the files cannot know them. Build the bundle with `buildHandoffBundle` from kernel/handoff-bundle.ts.
 */
export function collectHandoffInput(
  root: string,
  options: {
    repo: string;
    sha: string;
    generatedAt: string;
    destination: HandoffDestination;
    knownIssues?: string[];
    openTasks?: HandoffTask[];
  },
): HandoffInput {
  const sheetText = readFileSync(join(root, "gateway/role-sheet.yaml"), "utf8");
  const families = new Set([...sheetFamilies(parseRoleSheet(sheetText)), ...readCatalogMatch(sheetText).map((row) => row.family)]);
  const crew = parse(readFileSync(join(root, "crews", `${HANDOFF_CREW}.yaml`), "utf8")) as { capabilities?: unknown };
  const capabilities = Array.isArray(crew.capabilities) ? crew.capabilities.map(String) : [];
  const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  const shortcutSources: HandoffSource[] = [];
  for (const dir of SHORTCUT_DIRS) walk(root, dir, shortcutSources);
  return {
    repo: options.repo,
    sha: options.sha,
    generatedAt: options.generatedAt,
    destination: options.destination,
    allowedFamilies: [...families],
    charter: read(root, HANDOFF_SOURCES.charter),
    architecture: read(root, HANDOFF_SOURCES.architecture),
    runbook: HANDOFF_SOURCES.runbook.filter((path) => existsSync(join(root, path))).map((path) => read(root, path)),
    deployment: read(root, HANDOFF_SOURCES.deployment),
    tests: { commands: DONE_SCRIPTS.filter((name) => scripts[name]).map((name) => (name === "test" ? "npm test" : `npm run ${name}`)) },
    knownIssues: options.knownIssues ?? [],
    shortcutSources,
    openTasks: options.openTasks ?? [],
    capabilities,
  };
}
