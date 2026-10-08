import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { parse } from "yaml";
import { readCatalogMatch } from "../gateway/catalog.ts";
import type { HandoffDestination, HandoffInput, HandoffSource, HandoffTask } from "../kernel/handoff-bundle.ts";
import { parseRoleSheet, sheetFamilies } from "../kernel/role-sheet.ts";
import { TarFormatError, TarReader } from "./tar-stream.ts";

export const HANDOFF_CREW = "handoff";

/** Where each bundle section comes from in a checkout of dexter-hq itself. */
export const HANDOFF_SOURCES = {
  charter: "AGENTS.md",
  architecture: "README.md",
  runbook: ["ops/README-watchdog.md", "ops/README-checker.md", "docs/LOCAL_BOOT.md"],
  // dexter-shortcut: no dedicated deployment doc yet, so the production tick wiring stands in; upgrade path: point this
  // at a docs/DEPLOY.md that covers the hosting project, migrations, and edge functions.
  deployment: "ops/README-tick.md",
} as const;

/**
 * Any repo (a venture's included): the first file that exists wins. README.md is the last resort for every section,
 * so a small venture repo with only a README still hands off.
 */
const CANDIDATES = {
  charter: [HANDOFF_SOURCES.charter, "CLAUDE.md", "README.md"],
  architecture: [HANDOFF_SOURCES.architecture, "docs/ARCHITECTURE.md", "ARCHITECTURE.md"],
  runbook: [...HANDOFF_SOURCES.runbook, "docs/RUNBOOK.md", "RUNBOOK.md", "CONTRIBUTING.md"],
  deployment: [HANDOFF_SOURCES.deployment, "docs/DEPLOY.md", "DEPLOY.md", "docs/DEPLOYMENT.md", "README.md"],
} as const;
const DOC_PATHS = new Set<string>([...Object.values(CANDIDATES).flat(), "package.json"]);

/** Code scanned for shortcut markers. Tests, docs, and generated bundles are not debt. */
const SHORTCUT_DIRS = ["hq", "kernel", "app", "gateway", "adapters", "scripts", "supabase/functions", "src", "lib"];
const SHORTCUT_SKIP = /(?:^|\/)(?:node_modules|generated|_shared)(?:\/|$)/;
const SHORTCUT_EXT = /\.(?:ts|tsx|js|mjs|sh|sql)$/;
/** The package.json scripts a maintainer runs before merging, in order. */
const DONE_SCRIPTS = ["typecheck", "lint", "test", "check:vendor", "check:briefs", "check:bundle", "scan:secrets", "test:integration"];

/** True for the files a bundle reads: the section docs, package.json, and code that can carry shortcut markers. */
export function handoffWanted(path: string): boolean {
  if (DOC_PATHS.has(path)) return true;
  if (SHORTCUT_SKIP.test(path) || !SHORTCUT_EXT.test(path)) return false;
  return SHORTCUT_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

export type HandoffCollectOptions = {
  repo: string;
  sha: string;
  generatedAt: string;
  destination: HandoffDestination;
  /** HQ's role-sheet families; they come from HQ, not from the repo being handed off. */
  allowedFamilies: readonly string[];
  /** The handoff crew's capabilities, from HQ's crews/handoff.yaml. */
  capabilities: readonly string[];
  knownIssues?: string[];
  openTasks?: HandoffTask[];
};

/**
 * The bundle's input from a repo snapshot (path -> text). `knownIssues` and `openTasks` come from the caller (the
 * board), since the files cannot know them. Returns the sections no file could fill instead of an input.
 */
export function collectHandoffInputFromFiles(
  files: ReadonlyMap<string, string>,
  options: HandoffCollectOptions,
): HandoffInput | { missing: string[] } {
  const pick = (paths: readonly string[]): HandoffSource | null => {
    const path = paths.find((candidate) => files.has(candidate));
    return path ? { path, text: files.get(path)! } : null;
  };
  const charter = pick(CANDIDATES.charter);
  const architecture = pick(CANDIDATES.architecture) ?? pick(["README.md"]);
  const runbookPaths = CANDIDATES.runbook.filter((path) => files.has(path));
  const runbook = (runbookPaths.length > 0 ? runbookPaths : files.has("README.md") ? ["README.md"] : []).map((path) => ({
    path,
    text: files.get(path)!,
  }));
  const deployment = pick(CANDIDATES.deployment);
  const missing = [
    ...(charter ? [] : ["charter"]),
    ...(architecture ? [] : ["architecture"]),
    ...(runbook.length > 0 ? [] : ["runbook"]),
    ...(deployment ? [] : ["deployment"]),
  ];
  if (!charter || !architecture || !deployment || missing.length > 0) return { missing };
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(files.get("package.json") ?? "{}") as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  } catch {
    scripts = {};
  }
  const shortcutSources = [...files.keys()]
    .filter((path) => !DOC_PATHS.has(path) && handoffWanted(path))
    .sort()
    .map((path) => ({ path, text: files.get(path)! }));
  return {
    repo: options.repo,
    sha: options.sha,
    generatedAt: options.generatedAt,
    destination: options.destination,
    allowedFamilies: [...options.allowedFamilies],
    charter,
    architecture,
    runbook,
    deployment,
    tests: { commands: DONE_SCRIPTS.filter((name) => scripts[name]).map((name) => (name === "test" ? "npm test" : `npm run ${name}`)) },
    knownIssues: options.knownIssues ?? [],
    shortcutSources,
    openTasks: options.openTasks ?? [],
    capabilities: [...options.capabilities],
  };
}

function walk(root: string, dir: string, out: Map<string, string>): void {
  const full = join(root, dir);
  if (!existsSync(full)) return;
  for (const name of readdirSync(full).sort()) {
    const path = join(full, name);
    const rel = relative(root, path).split("\\").join("/");
    if (SHORTCUT_SKIP.test(rel)) continue;
    if (statSync(path).isDirectory()) walk(root, rel, out);
    else if (handoffWanted(rel)) out.set(rel, readFileSync(path, "utf8"));
  }
}

/** The handoff crew's capabilities as HQ declares them in crews/handoff.yaml under `root`. */
export function handoffCapabilities(root: string): string[] {
  const crew = parse(readFileSync(join(root, "crews", `${HANDOFF_CREW}.yaml`), "utf8")) as { capabilities?: unknown };
  return Array.isArray(crew.capabilities) ? crew.capabilities.map(String) : [];
}

/**
 * Reads the bundle's sources from a checkout of dexter-hq (role sheet and crew file included). Build the bundle with
 * `buildHandoffBundle` from kernel/handoff-bundle.ts.
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
  const files = new Map<string, string>();
  for (const path of DOC_PATHS) if (existsSync(join(root, path))) files.set(path, readFileSync(join(root, path), "utf8"));
  for (const dir of SHORTCUT_DIRS) walk(root, dir, files);
  const input = collectHandoffInputFromFiles(files, { ...options, allowedFamilies: [...families], capabilities: handoffCapabilities(root) });
  if ("missing" in input) throw new Error(`handoff_sources_missing:${input.missing.join(",")}`);
  return input;
}

/** A repo snapshot at one commit: only the files `handoffWanted` keeps. */
export type HandoffSnapshot = { sha: string; files: Map<string, string> };
/** Reads a repo for a handoff launch. `ref` is the request's bound branch, or null for the default branch. */
export type HandoffRepoSource = (input: { repo: string; ref: string | null }) => Promise<HandoffSnapshot>;

const GITHUB_API = "https://api.github.com";
const SOURCE_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** A tarball entry's path below GitHub's `<owner>-<repo>-<sha>/` top directory, or null when unsafe or the top itself. */
export function snapshotPath(name: string): string | null {
  const slash = name.indexOf("/");
  if (slash < 0) return null;
  const rest = name.slice(slash + 1);
  if (!rest || rest.startsWith("/") || rest.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  return rest;
}

/**
 * The live source: GitHub's REST API with HQ's token. The ref resolves to a full sha first, then one tarball at that
 * sha is streamed and only wanted files are kept in memory (per-file and total caps; nothing is written to disk).
 */
export function createGhHandoffSource(options: { token: string; fetch?: typeof fetch; timeoutMs?: number }): HandoffRepoSource {
  const doFetch = options.fetch ?? fetch;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${options.token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "dexter-hq",
  };
  return async ({ repo, ref }) => {
    if (!REPO_PATTERN.test(repo)) throw new Error("handoff_source:bad_repo");
    const signal = AbortSignal.timeout(options.timeoutMs ?? SOURCE_TIMEOUT_MS);
    const commit = await doFetch(`${GITHUB_API}/repos/${repo}/commits/${encodeURIComponent(ref ?? "HEAD")}`, { headers, signal });
    if (!commit.ok) throw new Error(`handoff_source:commit_http_${commit.status}`);
    const sha = String(((await commit.json()) as { sha?: unknown }).sha ?? "").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("handoff_source:bad_sha");
    const tarball = await doFetch(`${GITHUB_API}/repos/${repo}/tarball/${sha}`, { headers, signal, redirect: "follow" });
    if (!tarball.ok || !tarball.body) throw new Error(`handoff_source:tarball_http_${tarball.status}`);
    const files = new Map<string, string>();
    let total = 0;
    const reader = new TarReader((name, size) => {
      const path = snapshotPath(name);
      if (!path || !handoffWanted(path) || size > MAX_FILE_BYTES) return null;
      total += size;
      if (total > MAX_TOTAL_BYTES) throw new TarFormatError("snapshot_too_large");
      const parts: Buffer[] = [];
      return {
        data: (part) => parts.push(Buffer.from(part)),
        end: () => files.set(path, Buffer.concat(parts).toString("utf8")),
      };
    });
    try {
      await pipeline(Readable.fromWeb(tarball.body as unknown as WebReadableStream<Uint8Array>), createGunzip(), reader);
    } catch (error) {
      throw new Error(`handoff_source:extract_failed:${error instanceof Error ? error.message : "unknown"}`);
    }
    return { sha, files };
  };
}
