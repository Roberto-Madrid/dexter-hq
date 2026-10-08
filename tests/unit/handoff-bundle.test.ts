import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SHIPPED_CREWS, loadCrews } from "../../hq/crews.ts";
import { HANDOFF_CREW, collectHandoffInput } from "../../hq/handoff.ts";
import { loadPersonas } from "../../hq/personas.ts";
import {
  HANDOFF_SECTION_MAX_CHARS,
  buildHandoffBundle,
  extractShortcutDebt,
  findHandoffSecrets,
  renderHandoffBundle,
  validateHandoffBundle,
  type HandoffInput,
} from "../../kernel/handoff-bundle.ts";
import { parseRoleSheet, sheetFamilies } from "../../kernel/role-sheet.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const MARK = ["dexter", "shortcut"].join("-");
const FAMILIES = [...sheetFamilies(parseRoleSheet(readFileSync("gateway/role-sheet.yaml", "utf8")))];

// Secret-looking values, assembled at runtime so this file itself never holds a literal.
const SEEDED = {
  ghp: `ghp_${"A1b2C3d4".repeat(4)}`,
  sk: `sk-${"Z9y8X7w6".repeat(3)}`,
  akia: `AKIA${"ABCDEFGH23456789"}`,
  pem: `-----BEGIN RSA ${"PRIVATE"} KEY-----`,
  jwt: `eyJ${"hbGciOiJIUzI1"}.eyJ${"zdWIiOiIxMjM0"}.${"c2lnbmF0dXJlMTIz"}`,
  pat: `${"github"}_pat_${"11ABCDEFG0".repeat(3)}`,
  url: `postgresql://dexter:${"s3cr3tPassw0rd"}@db.example.test:5432/postgres`,
  env: `SERVICE_ROLE_KEY=${"q8w7e6r5t4y3u2i1o0p9"}`,
  age: `AGE-SECRET-KEY-1${"QWERTYUIOPASDFGHJKLZXCVBNM"}`,
};
const SECRET_VALUES = [
  SEEDED.ghp,
  SEEDED.sk,
  SEEDED.akia,
  SEEDED.pem,
  SEEDED.jwt,
  SEEDED.pat,
  "s3cr3tPassw0rd",
  "q8w7e6r5t4y3u2i1o0p9",
  SEEDED.age,
];

function input(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    repo: "owner/demo",
    sha: SHA,
    generatedAt: "2026-10-08T17:00:00.000Z",
    destination: { kind: "model_family", family: FAMILIES[0]! },
    allowedFamilies: FAMILIES,
    charter: { path: "AGENTS.md", text: "# Charter\nKeep changes small. Evidence or it did not happen." },
    architecture: { path: "README.md", text: "# Architecture\nKernel is pure; hq/ holds the server." },
    runbook: [{ path: "ops/README-tick.md", text: "# Tick\nCheck heartbeats first." }],
    deployment: { path: "docs/LOCAL_BOOT.md", text: "# Deploy\nMerges do not deploy; the owner promotes." },
    tests: { commands: ["npm run typecheck", "npm test"] },
    knownIssues: ["Integration tests need local Postgres 16."],
    shortcutSources: [
      { path: "hq/a.ts", text: `const x = 1;\n// ${MARK}: no retry yet; upgrade path: add backoff\n` },
      { path: "hq/b.ts", text: `  /* ${MARK}: counts every row */` },
    ],
    openTasks: [{ id: "r1", title: "Wire the route", status: "queued" }],
    capabilities: ["read_repo", "run_checks"],
    ...overrides,
  };
}

describe("shortcut debt list", () => {
  it("collects each marker with its path, line, limit, and upgrade path", () => {
    expect(extractShortcutDebt(input().shortcutSources)).toEqual([
      { path: "hq/a.ts", line: 2, limit: "no retry yet", upgradePath: "add backoff" },
      { path: "hq/b.ts", line: 1, limit: "counts every row", upgradePath: null },
    ]);
  });

  it("joins a marker comment that continues on the next comment lines", () => {
    const multi = {
      path: "hq/c.ts",
      text: [
        `// ${MARK}: reads every post and filters in memory,`,
        "// which is fine while the board is small; upgrade path: push the filter",
        "// into SQL.",
        "const after = 1; // not part of it",
      ].join("\n"),
    };
    const sql = { path: "x.sql", text: `-- ${MARK}: no index on events. upgrade path: add one` };
    expect(extractShortcutDebt([multi, sql])).toEqual([
      {
        path: "hq/c.ts",
        line: 1,
        limit: "reads every post and filters in memory, which is fine while the board is small",
        upgradePath: "push the filter into SQL.",
      },
      { path: "x.sql", line: 1, limit: "no index on events", upgradePath: "add one" },
    ]);
  });

  it("skips the template line that only describes the marker", () => {
    const template = { path: "checklists/x.md", text: `\`${MARK}: <the limit>; upgrade path: <what should replace it>\`` };
    expect(extractShortcutDebt([template])).toEqual([]);
  });
});

describe("handoff bundle", () => {
  it("builds a schema-valid bundle with charter, runbook, deployment, tests, and the debt list", () => {
    const result = buildHandoffBundle(input());
    if (!result.ok) throw new Error(result.reasons.join(", "));
    const { bundle } = result;
    expect(validateHandoffBundle(JSON.parse(JSON.stringify(bundle)))).toMatchObject({ ok: true });
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.charter.body).toContain("Evidence or it did not happen");
    expect(bundle.runbook).toHaveLength(1);
    expect(bundle.shortcutDebt).toHaveLength(2);
    expect(bundle.tests.commands).toEqual(["npm run typecheck", "npm test"]);
    expect(bundle.redactions).toEqual([]);
    const text = renderHandoffBundle(bundle);
    for (const heading of ["## Charter", "## Architecture", "## Runbook", "## Deployment", "## Tests", "## Known issues", "## Shortcut debt", "## Open tasks", "## Capabilities"]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("hq/a.ts:2 no retry yet (upgrade path: add backoff)");
  });

  it("redacts seeded secret-looking values in every section and records where", () => {
    const dirty = Object.values(SEEDED).join("\n");
    const result = buildHandoffBundle(
      input({
        charter: { path: "AGENTS.md", text: `# Charter\n${dirty}` },
        runbook: [{ path: "ops/README-tick.md", text: `token ${SEEDED.ghp} here` }],
        knownIssues: [`leaked ${SEEDED.sk}`],
        openTasks: [{ id: "r1", title: `rotate ${SEEDED.akia}`, status: "queued" }],
        shortcutSources: [{ path: "hq/a.ts", text: `// ${MARK}: key ${SEEDED.ghp} inline; upgrade path: vault` }],
        tests: { commands: [`DATABASE_URL=${SEEDED.url} npm test`] },
      }),
    );
    if (!result.ok) throw new Error(result.reasons.join(", "));
    const json = JSON.stringify(result.bundle);
    for (const value of SECRET_VALUES) expect(json).not.toContain(value);
    expect(json).toContain("[redacted]");
    expect(json).toContain("SERVICE_ROLE_KEY=[redacted]");
    expect(json).toContain("postgresql://[redacted]@db.example.test");
    expect(findHandoffSecrets(json)).toEqual([]);
    expect(findHandoffSecrets(renderHandoffBundle(result.bundle))).toEqual([]);
    const sections = new Set(result.bundle.redactions.map((row) => row.section));
    for (const section of ["charter", "runbook", "knownIssues", "openTasks", "shortcutDebt", "tests"]) expect(sections).toContain(section);
    // Counts, never the values.
    expect(JSON.stringify(result.bundle.redactions)).not.toMatch(/ghp_|sk-|AKIA/);
  });

  it("rejects secret files as sources outright", () => {
    for (const path of [".env", ".env.local", "deploy/id_rsa", "certs/server.pem", "keys/signing.key"]) {
      const result = buildHandoffBundle(input({ runbook: [{ path, text: "harmless" }] }));
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.reasons).toContain(`secret_file:${path}`);
    }
    expect(buildHandoffBundle(input({ runbook: [{ path: ".env.example", text: "NAME=" }] }))).toMatchObject({ ok: true });
  });

  it("validation rejects a bundle that carries a secret or misses a required section", () => {
    const result = buildHandoffBundle(input());
    if (!result.ok) throw new Error("expected ok");
    const tampered = { ...result.bundle, knownIssues: [`oops ${SEEDED.ghp}`] };
    const verdict = validateHandoffBundle(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reasons.join(" ")).toContain("secret:ghp");
      expect(verdict.reasons.join(" ")).not.toContain(SEEDED.ghp);
    }
    // A value right after a newline is still caught (JSON text would hide it behind "\\n").
    expect(validateHandoffBundle({ ...result.bundle, knownIssues: [`line\n${SEEDED.sk}`] })).toMatchObject({ ok: false });
    expect(validateHandoffBundle({ ...result.bundle, runbook: [] })).toMatchObject({ ok: false });
    expect(validateHandoffBundle({ ...result.bundle, charter: undefined })).toMatchObject({ ok: false });
    expect(validateHandoffBundle({ ...result.bundle, sha: "main" })).toMatchObject({ ok: false });
  });

  it("caps each section and says it was truncated", () => {
    const result = buildHandoffBundle(input({ architecture: { path: "README.md", text: "x".repeat(HANDOFF_SECTION_MAX_CHARS + 50) } }));
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundle.architecture.body.length).toBeLessThanOrEqual(HANDOFF_SECTION_MAX_CHARS + 40);
    expect(result.bundle.architecture.truncated).toBe(true);
  });

  it("sends only to a role-sheet family or an agent the owner launches", () => {
    expect(buildHandoffBundle(input({ destination: { kind: "model_family", family: "not-a-family" } }))).toMatchObject({
      ok: false,
      reasons: ["unknown_family:not-a-family"],
    });
    const owner = buildHandoffBundle(input({ destination: { kind: "owner_launched", agent: "maintenance bot" } }));
    if (!owner.ok) throw new Error("expected ok");
    expect(renderHandoffBundle(owner.bundle)).toContain("The owner launches maintenance bot with this bundle; the CEO never drives it.");
  });
});

describe("handoff crew", () => {
  it("ships a crew file whose personas and roles exist", () => {
    const crew = loadCrews().get(HANDOFF_CREW);
    expect(crew?.tasks.map((task) => [task.persona, task.role, task.artifact])).toEqual([
      ["writer", "writer", "note"],
      ["builder", "builder", "check"],
    ]);
    const personas = loadPersonas();
    const sheet = parseRoleSheet(readFileSync("gateway/role-sheet.yaml", "utf8"));
    for (const task of crew?.tasks ?? []) {
      expect(personas.has(task.persona)).toBe(true);
      expect(sheet.roles[task.role]).toBeDefined();
    }
    const raw = parse(readFileSync("crews/handoff.yaml", "utf8")) as { capabilities?: string[] };
    expect(raw.capabilities?.length).toBeGreaterThan(0);
  });

  it("is not yet a crew a plan card can pick (launch wiring lives in the connector)", () => {
    expect(SHIPPED_CREWS as readonly string[]).not.toContain(HANDOFF_CREW);
  });
});

describe("handoff from this repository", () => {
  it("assembles a valid, secret-free bundle with the real debt list", () => {
    const collected = collectHandoffInput(".", {
      repo: "owner/dexter-hq",
      sha: SHA,
      generatedAt: "2026-10-08T17:00:00.000Z",
      destination: { kind: "owner_launched", agent: "maintenance agent" },
    });
    const result = buildHandoffBundle(collected);
    if (!result.ok) throw new Error(result.reasons.join(", "));
    expect(result.bundle.charter.source).toBe("AGENTS.md");
    expect(result.bundle.runbook.length).toBeGreaterThan(0);
    expect(result.bundle.shortcutDebt.length).toBeGreaterThan(5);
    expect(result.bundle.shortcutDebt.some((row) => row.path === "hq/crews.ts")).toBe(true);
    expect(result.bundle.shortcutDebt.every((row) => !row.path.startsWith("tests/") && !row.path.includes("generated"))).toBe(true);
    expect(result.bundle.capabilities).toEqual((parse(readFileSync("crews/handoff.yaml", "utf8")) as { capabilities: string[] }).capabilities);
    expect(result.bundle.tests.commands).toContain("npm run typecheck");
    expect(findHandoffSecrets(JSON.stringify(result.bundle))).toEqual([]);
    expect(validateHandoffBundle(JSON.parse(JSON.stringify(result.bundle)))).toMatchObject({ ok: true });
  });
});
