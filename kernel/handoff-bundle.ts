import { z } from "zod";
import { SECRET_RULES, ruleRegExp, type TextRule } from "./patterns.ts";

/**
 * Maintenance handoff bundle: everything another agent needs to keep a repo running, with no secret values.
 * Pure: callers read the files (hq/handoff.ts) and pass their text in. Every string is redacted on the way in, and
 * validation rejects any bundle that still carries a secret-looking value.
 */
export const HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_SECTION_MAX_CHARS = 20_000;
const REDACTED = "[redacted]";

/**
 * The shared secret rules plus shapes a repo's docs tend to leak: fine-grained tokens, JWTs, credentials in a URL,
 * and secret-named assignments with a long mixed value. `keep` is the prefix kept in front of `[redacted]`.
 */
const HANDOFF_SECRET_RULES: readonly (TextRule & { keep?: number })[] = [
  ...SECRET_RULES,
  { id: "fine_grained_pat", source: "\\b[a-z]+_pat_[A-Za-z0-9_]{20,}", flags: "g" },
  { id: "jwt", source: "\\beyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}", flags: "g" },
  { id: "url_credentials", source: "\\b([a-z][a-z0-9+.-]*://)[^\\s:/@]+:[^\\s@/]+@", flags: "gi", keep: 1 },
  {
    id: "secret_assignment",
    source:
      "\\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ROLE_KEY)[A-Z0-9_]*\\s*[=:]\\s*['\"]?)(?![\\[<$])(?=[^\\s'\"]*\\d)(?=[^\\s'\"]*[A-Za-z])[^\\s'\"]{16,}",
    flags: "g",
    keep: 1,
  },
];

/** Files that are secrets by name. Their text never enters a bundle. `.env.example` lists names only, so it may. */
const SECRET_FILE = /(?:^|\/)(?:\.env(?!\.example$)(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx)|credentials\.json)$/i;

function withGlobal(rule: TextRule): RegExp {
  const flags = rule.flags.includes("g") ? rule.flags : `${rule.flags}g`;
  return ruleRegExp({ ...rule, flags });
}

/** Rule ids of every secret-looking value in `text`. Never the values. */
export function findHandoffSecrets(text: string): string[] {
  return HANDOFF_SECRET_RULES.filter((rule) => {
    const re = withGlobal(rule);
    for (const match of text.matchAll(re)) {
      // A kept prefix followed by the placeholder is already clean.
      const rest = text.slice((match.index ?? 0) + (match[1]?.length ?? 0));
      if (!rest.startsWith(REDACTED)) return true;
    }
    return false;
  }).map((rule) => rule.id);
}

function redactCounting(text: string): { text: string; hits: Record<string, number> } {
  let out = text;
  const hits: Record<string, number> = {};
  for (const rule of HANDOFF_SECRET_RULES) {
    out = out.replace(withGlobal(rule), (...args: unknown[]) => {
      const match = String(args[0]);
      const kept = rule.keep ? String(args[rule.keep] ?? "") : "";
      hits[rule.id] = (hits[rule.id] ?? 0) + 1;
      return `${kept}${REDACTED}${match.endsWith("@") && rule.id === "url_credentials" ? "@" : ""}`;
    });
  }
  return { text: out, hits };
}

const MARKER = `${["dexter", "shortcut"].join("-")}:`;

export type HandoffSource = { path: string; text: string };
export type ShortcutDebt = { path: string; line: number; limit: string; upgradePath: string | null };
export type HandoffDestination = { kind: "model_family"; family: string } | { kind: "owner_launched"; agent: string };
export type HandoffTask = { id: string; title: string; status: string };

export type HandoffInput = {
  repo: string;
  sha: string;
  generatedAt: string;
  destination: HandoffDestination;
  /** Families the role sheet knows; a `model_family` destination must be one of them. */
  allowedFamilies: readonly string[];
  charter: HandoffSource;
  architecture: HandoffSource;
  runbook: HandoffSource[];
  deployment: HandoffSource;
  tests: { commands: string[] };
  knownIssues: string[];
  /** Source files scanned for shortcut markers. */
  shortcutSources: HandoffSource[];
  openTasks: HandoffTask[];
  capabilities: string[];
};

const COMMENT_LINE = /^\s*(?:\/\/|\*(?!\/)|#|--)\s?(.*)$/;
const MAX_CONTINUATION_LINES = 6;

function stripCommentEnd(text: string): string {
  return text
    .replace(/\s*(?:\*\/|-->)\s*$/, "")
    .replace(/[`"']+\s*$/, "")
    .trim();
}

/**
 * Every shortcut marker as `{ path, line, limit, upgradePath }`, skipping the template that only describes it. A marker
 * comment may continue on the following comment lines (`//`, `*`, `#`, `--`); those are joined before parsing.
 */
export function extractShortcutDebt(files: readonly HandoffSource[]): ShortcutDebt[] {
  const rows: ShortcutDebt[] = [];
  for (const file of files) {
    const lines = file.text.split("\n");
    lines.forEach((raw, index) => {
      const at = raw.indexOf(MARKER);
      if (at < 0) return;
      const parts = [stripCommentEnd(raw.slice(at + MARKER.length))];
      const closed = /\*\/|-->/.test(raw.slice(at));
      for (let next = index + 1; !closed && next < lines.length && next <= index + MAX_CONTINUATION_LINES; next += 1) {
        const continued = lines[next]!.match(COMMENT_LINE);
        if (!continued || lines[next]!.includes(MARKER)) break;
        const text = stripCommentEnd(continued[1] ?? "");
        if (!text) break;
        parts.push(text);
        if (/\*\/|-->/.test(lines[next]!)) break;
      }
      const body = parts.join(" ").replace(/\s+/g, " ").trim();
      const split = body.match(/^(.*?)[;.,]?\s*upgrade path:\s*(.*)$/i);
      const limit = (split ? split[1]! : body).trim().replace(/[;.,]$/, "");
      const upgradePath = split ? split[2]!.trim() || null : null;
      if (!limit || limit.startsWith("<")) return;
      rows.push({ path: file.path, line: index + 1, limit, upgradePath });
    });
  }
  return rows;
}

const nonEmpty = z.string().trim().min(1);
const SectionSchema = z.object({ title: nonEmpty, source: nonEmpty, body: nonEmpty, truncated: z.boolean() });

const BundleShape = z.object({
  schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
  repo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  generatedAt: z.string().datetime({ offset: true }),
  destination: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("model_family"), family: nonEmpty }),
    z.object({ kind: z.literal("owner_launched"), agent: nonEmpty }),
  ]),
  charter: SectionSchema,
  architecture: SectionSchema,
  runbook: z.array(SectionSchema).min(1),
  deployment: SectionSchema,
  tests: z.object({ commands: z.array(nonEmpty).min(1) }),
  knownIssues: z.array(nonEmpty),
  shortcutDebt: z.array(
    z.object({ path: nonEmpty, line: z.number().int().positive(), limit: nonEmpty, upgradePath: nonEmpty.nullable() }),
  ),
  openTasks: z.array(z.object({ id: nonEmpty, title: nonEmpty, status: nonEmpty })),
  capabilities: z.array(nonEmpty).min(1),
  redactions: z.array(z.object({ section: nonEmpty, rule: nonEmpty, count: z.number().int().positive() })),
});

/** The bundle schema. Beyond shape, no string anywhere in it may look like a secret. */
export const HandoffBundleSchema = BundleShape.superRefine((bundle, ctx) => {
  const found = new Set<string>();
  // Each string on its own: scanning JSON text would hide a value behind an escape such as "\\n".
  for (const text of stringsIn(bundle)) for (const rule of findHandoffSecrets(text)) found.add(rule);
  for (const rule of found) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `secret:${rule}` });
});

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

export type HandoffBundle = z.infer<typeof BundleShape>;
export type HandoffResult = { ok: true; bundle: HandoffBundle } | { ok: false; reasons: string[] };

function issues(error: z.ZodError): string[] {
  return error.issues.map((issue) => (issue.code === "custom" ? issue.message : `${issue.path.join(".") || "bundle"}:${issue.code}`));
}

export function validateHandoffBundle(value: unknown): HandoffResult {
  const parsed = HandoffBundleSchema.safeParse(value);
  return parsed.success ? { ok: true, bundle: parsed.data } : { ok: false, reasons: issues(parsed.error) };
}

export function buildHandoffBundle(input: HandoffInput): HandoffResult {
  const reasons: string[] = [];
  const sources = [input.charter, input.architecture, input.deployment, ...input.runbook, ...input.shortcutSources];
  for (const source of sources) if (SECRET_FILE.test(source.path)) reasons.push(`secret_file:${source.path}`);
  if (input.destination.kind === "model_family" && !input.allowedFamilies.includes(input.destination.family)) {
    reasons.push(`unknown_family:${input.destination.family}`);
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const redactions = new Map<string, number>();
  const clean = (section: string, text: string): string => {
    const result = redactCounting(text);
    for (const [rule, count] of Object.entries(result.hits)) {
      const key = `${section}\u0000${rule}`;
      redactions.set(key, (redactions.get(key) ?? 0) + count);
    }
    return result.text;
  };
  const section = (name: string, source: HandoffSource) => {
    const text = clean(name, source.text).trim();
    const truncated = text.length > HANDOFF_SECTION_MAX_CHARS;
    const body = truncated ? `${text.slice(0, HANDOFF_SECTION_MAX_CHARS)}\n[truncated ${text.length - HANDOFF_SECTION_MAX_CHARS} chars]` : text;
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? source.path;
    return { title, source: source.path, body, truncated };
  };

  const draft = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    repo: input.repo,
    sha: input.sha.toLowerCase(),
    generatedAt: input.generatedAt,
    destination:
      input.destination.kind === "model_family"
        ? { kind: "model_family" as const, family: input.destination.family }
        : { kind: "owner_launched" as const, agent: clean("destination", input.destination.agent) },
    charter: section("charter", input.charter),
    architecture: section("architecture", input.architecture),
    runbook: input.runbook.map((source) => section("runbook", source)),
    deployment: section("deployment", input.deployment),
    tests: { commands: input.tests.commands.map((command) => clean("tests", command)) },
    knownIssues: input.knownIssues.map((item) => clean("knownIssues", item)),
    shortcutDebt: extractShortcutDebt(input.shortcutSources).map((row) => ({
      ...row,
      limit: clean("shortcutDebt", row.limit),
      upgradePath: row.upgradePath === null ? null : clean("shortcutDebt", row.upgradePath),
    })),
    openTasks: input.openTasks.map((task) => ({ id: task.id, title: clean("openTasks", task.title), status: task.status })),
    capabilities: [...input.capabilities],
    redactions: [...redactions.entries()].map(([key, count]) => {
      const [name, rule] = key.split("\u0000");
      return { section: name!, rule: rule!, count };
    }),
  };
  return validateHandoffBundle(draft);
}

/** The bundle as one Markdown brief for the agent taking over. */
export function renderHandoffBundle(bundle: HandoffBundle): string {
  const destination =
    bundle.destination.kind === "model_family"
      ? `Destination: a ${bundle.destination.family} agent launched through the connector.`
      : `The owner launches ${bundle.destination.agent} with this bundle; the CEO never drives it.`;
  const list = (items: string[]) => (items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none");
  const sectionText = (heading: string, body: { source: string; body: string }) => `## ${heading}\n_Source: ${body.source}_\n\n${body.body}`;
  return [
    `# Maintenance handoff: ${bundle.repo} at ${bundle.sha}`,
    `Generated ${bundle.generatedAt}. ${destination}`,
    sectionText("Charter", bundle.charter),
    sectionText("Architecture", bundle.architecture),
    `## Runbook\n\n${bundle.runbook.map((item) => `### ${item.title}\n_Source: ${item.source}_\n\n${item.body}`).join("\n\n")}`,
    sectionText("Deployment", bundle.deployment),
    `## Tests\n${list(bundle.tests.commands.map((command) => `\`${command}\``))}`,
    `## Known issues\n${list(bundle.knownIssues)}`,
    `## Shortcut debt\n${list(
      bundle.shortcutDebt.map((row) => `${row.path}:${row.line} ${row.limit}${row.upgradePath ? ` (upgrade path: ${row.upgradePath})` : ""}`),
    )}`,
    `## Open tasks\n${list(bundle.openTasks.map((task) => `${task.title} [${task.status}] (${task.id})`))}`,
    `## Capabilities\n${list(bundle.capabilities)}`,
  ].join("\n\n");
}
