import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callConnectorTool, type ConnectorDeps } from "../../hq/connector.ts";
import { SHIPPED_CREWS } from "../../hq/crews.ts";
import {
  HANDOFF_CREW,
  collectHandoffInputFromFiles,
  createGhHandoffSource,
  handoffWanted,
  type HandoffRepoSource,
} from "../../hq/handoff.ts";
import { SKILL_MAX_WORDS, skillBudget } from "../../hq/token-police.ts";
import { capsAuth, capsDeps } from "./caps-fixtures.ts";

const SHA = "89abcdef0123456789abcdef0123456789abcdef";
const MARK = ["dexter", "shortcut"].join("-");
// Assembled at runtime so this file never holds a literal secret.
const TOKEN = `ghp_${"Q1w2E3r4".repeat(4)}`;

function ventureFiles(extra: Record<string, string> = {}): Map<string, string> {
  return new Map(
    Object.entries({
      "AGENTS.md": "# Barber site\nKeep bookings working. Never store card data.",
      "README.md": "# Barber site\nNext.js app on Vercel with a Supabase bookings table.",
      "docs/LOCAL_BOOT.md": "# Local boot\nnpm install, then npm run dev.",
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint .", test: "vitest run" } }),
      "scripts/seed.ts": `// ${MARK}: seeds one fake shop; upgrade path: load fixtures per shop.\nexport {};\n`,
      ...extra,
    }),
  );
}

function source(files: Map<string, string>, calls: { repo: string; ref: string | null }[] = []): HandoffRepoSource {
  return async (input) => {
    calls.push(input);
    return { sha: SHA, files };
  };
}

async function setup(options: { handoffSource?: HandoffRepoSource | null; crew?: string } = {}) {
  const ctx = await capsDeps();
  await ctx.store.saveRequest({
    id: "req-handoff",
    ownerId: capsAuth.ownerId,
    goal: "Move the barber site to maintenance.",
    status: "queued",
    card: { crew: options.crew ?? HANDOFF_CREW, newScreen: false, requiresDesignApproval: false },
    evidence: [],
    assignedBotId: capsAuth.id,
    repo: "owner/a",
    branch: "main",
    notices: [],
  });
  const deps: ConnectorDeps = { ...ctx.deps, handoffSource: options.handoffSource === undefined ? null : options.handoffSource };
  return { ...ctx, deps };
}

const launchHandoff = (deps: ConnectorDeps, brief = "Take over maintenance of this repo.", key = "h1") =>
  callConnectorTool(deps, capsAuth, "launch_agent", { role: "writer", brief, idempotencyKey: key, requestId: "req-handoff" });

describe("handoff crew registration", () => {
  it("ships the handoff crew, so a plan card keeps it", async () => {
    expect(SHIPPED_CREWS).toContain("handoff");
    const { deps, store } = await setup();
    const opened = await callConnectorTool(deps, capsAuth, "open_request", {
      goal: "Move owner/a to maintenance.",
      repo: "owner/a",
      card: {
        crew: "handoff",
        personas: ["writer", "builder"],
        councilMode: "quick",
        tier: "T2",
        definitionOfDone: "bundle delivered and checks green",
        outOfScope: "none",
        needsOwner: [],
        newScreen: false,
        outwardAction: false,
        requiresDesignApproval: false,
        requiresApproval: false,
      },
    });
    const request = await store.getRequest(String(opened.structuredContent.requestId));
    expect(request?.card?.crew).toBe("handoff");
    expect(request?.card?.notices ?? []).toEqual([]);
  });

  it("a handoff launch stores the bundle as an artifact and the brief references it", async () => {
    const calls: { repo: string; ref: string | null }[] = [];
    const { deps, cursor } = await setup({ handoffSource: source(ventureFiles(), calls) });
    const result = await launchHandoff(deps);
    expect(result.structuredContent).toMatchObject({ status: "launched" });
    expect(calls).toEqual([{ repo: "owner/a", ref: "main" }]);
    const handoff = result.structuredContent.handoff as { artifactId: string; sha: string; postId: string };
    expect(handoff.sha).toBe(SHA);
    const brief = cursor.starts[0]!.brief;
    expect(brief).toContain("Take over maintenance of this repo.");
    expect(brief).toContain(`artifact ${handoff.artifactId}`);
    expect(brief).toContain(`owner/a at ${SHA}`);
    expect(brief).toContain("AGENTS.md");
    expect(brief).toContain("npm test");
    expect(brief).toContain("Shortcut debt: 1");
    const page = await callConnectorTool(deps, capsAuth, "get_context", { artifactId: handoff.artifactId });
    const artifact = page.structuredContent.artifact as { text: string; truncated: boolean };
    expect(artifact.text).toContain(`# Maintenance handoff: owner/a at ${SHA}`);
    expect(artifact.text).toContain("Keep bookings working.");
    expect(artifact.text).toContain("seeds one fake shop");
    expect(artifact.truncated).toBe(false);
  });

  it("a secret value in a source is redacted in the bundle and never reaches the brief", async () => {
    const files = ventureFiles({ "README.md": `# Barber site\nDeploy with GH_TOKEN ${TOKEN} from the vault.` });
    const { deps, cursor } = await setup({ handoffSource: source(files) });
    const result = await launchHandoff(deps);
    expect(result.structuredContent).toMatchObject({ status: "launched" });
    const handoff = result.structuredContent.handoff as { artifactId: string; redactions: number };
    expect(handoff.redactions).toBeGreaterThan(0);
    expect(cursor.starts[0]!.brief).not.toContain(TOKEN);
    // README.md fills both architecture and deployment here, so the one value is redacted in each section.
    expect(cursor.starts[0]!.brief).toContain(`Secret values redacted: ${handoff.redactions}.`);
    const page = await callConnectorTool(deps, capsAuth, "get_context", { artifactId: handoff.artifactId });
    const text = (page.structuredContent.artifact as { text: string }).text;
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("[redacted]");
    expect(JSON.stringify(await deps.store.listEvents())).not.toContain(TOKEN);
  });

  it("a secret file among the sources refuses the launch and starts nothing", async () => {
    const files = ventureFiles({ "scripts/.env.ts": "export const KEY = 1;" });
    const { deps, cursor, store } = await setup({ handoffSource: source(files) });
    const result = await launchHandoff(deps);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "refused", reason: "handoff_bundle_invalid" });
    expect(result.structuredContent.reasons).toContain("secret_file:scripts/.env.ts");
    expect(cursor.starts).toHaveLength(0);
    expect(await store.findLaunch(capsAuth.id, "h1")).toBeNull();
  });

  it("respects the token police word cap on the brief", async () => {
    const { deps, cursor } = await setup({ handoffSource: source(ventureFiles()) });
    const ok = await launchHandoff(deps);
    expect(ok.structuredContent.status).toBe("launched");
    const sent = cursor.starts[0]!.brief ?? "";
    const callerAndPointer = sent.slice(sent.indexOf("Take over maintenance"));
    expect(skillBudget(callerAndPointer).over).toBe(false);
    const long = Array.from({ length: SKILL_MAX_WORDS - 20 }, (_, i) => `w${i}`).join(" ");
    const over = await launchHandoff(deps, long, "h2");
    expect(over.structuredContent).toMatchObject({ status: "refused", reason: "brief_over_word_cap", maxWords: SKILL_MAX_WORDS });
    expect(Number(over.structuredContent.words)).toBeGreaterThan(SKILL_MAX_WORDS);
    expect(cursor.starts).toHaveLength(1);
  });

  it("fails closed when no repo source is configured", async () => {
    const { deps, cursor } = await setup({ handoffSource: null });
    const result = await launchHandoff(deps);
    expect(result.structuredContent).toMatchObject({ status: "not-configured", reason: "handoff_source_unavailable" });
    expect(cursor.starts).toHaveLength(0);
  });

  it("a source that cannot be read refuses the launch", async () => {
    const { deps, cursor } = await setup({
      handoffSource: async () => {
        throw new Error("http_404");
      },
    });
    const result = await launchHandoff(deps);
    expect(result.structuredContent).toMatchObject({ status: "refused", reason: "handoff_source_failed" });
    expect(cursor.starts).toHaveLength(0);
  });

  it("leaves other crews' briefs alone", async () => {
    const calls: { repo: string; ref: string | null }[] = [];
    const { deps, cursor } = await setup({ crew: "change", handoffSource: source(ventureFiles(), calls) });
    const result = await launchHandoff(deps);
    expect(result.structuredContent.status).toBe("launched");
    expect(result.structuredContent.handoff).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(cursor.starts[0]!.brief).not.toContain("Maintenance handoff");
  });
});

describe("handoff sources from a repo snapshot", () => {
  const options = {
    repo: "owner/a",
    sha: SHA,
    generatedAt: "2026-10-08T12:00:00.000Z",
    destination: { kind: "model_family" as const, family: "grok" },
    allowedFamilies: ["grok"],
    capabilities: ["read_repo"],
  };

  it("falls back to README.md when a venture repo has no AGENTS.md or runbook", () => {
    const files = new Map([
      ["README.md", "# Shop\nRun npm test."],
      ["package.json", JSON.stringify({ scripts: { test: "vitest" } })],
    ]);
    const input = collectHandoffInputFromFiles(files, options);
    expect("missing" in input).toBe(false);
    if ("missing" in input) return;
    expect(input.charter.path).toBe("README.md");
    expect(input.runbook.map((item) => item.path)).toEqual(["README.md"]);
    expect(input.deployment.path).toBe("README.md");
    expect(input.tests.commands).toEqual(["npm test"]);
  });

  it("reports what is missing when there is nothing to hand off", () => {
    expect(collectHandoffInputFromFiles(new Map(), options)).toEqual({ missing: ["charter", "architecture", "runbook", "deployment"] });
  });

  it("only wants docs, package.json and code that can carry shortcut markers", () => {
    expect(handoffWanted("AGENTS.md")).toBe(true);
    expect(handoffWanted("ops/README-tick.md")).toBe(true);
    expect(handoffWanted("package.json")).toBe(true);
    expect(handoffWanted("hq/connector.ts")).toBe(true);
    expect(handoffWanted("app/generated/hq.js")).toBe(false);
    expect(handoffWanted("public/logo.png")).toBe(false);
    expect(handoffWanted("node_modules/x/index.js")).toBe(false);
  });

  it("reads a GitHub tarball at the resolved sha with GH_HQ_TOKEN, keeping only wanted files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "handoff-tar-"));
    const top = join(dir, `owner-a-${SHA.slice(0, 7)}`);
    for (const [path, text] of Object.entries({
      "AGENTS.md": "# Charter",
      "README.md": "# Readme",
      "package.json": "{}",
      "hq/x.ts": "export {};",
      "public/big.bin": "x".repeat(4096),
    })) {
      mkdirSync(join(top, path, ".."), { recursive: true });
      writeFileSync(join(top, path), text);
    }
    execFileSync("tar", ["-czf", join(dir, "repo.tgz"), "-C", dir, `owner-a-${SHA.slice(0, 7)}`]);
    const tarball = readFileSync(join(dir, "repo.tgz"));
    const seen: { url: string; auth: string | null }[] = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      seen.push({ url: href, auth: new Headers(init?.headers).get("authorization") });
      if (href.endsWith("/repos/owner/a/commits/main")) return Response.json({ sha: SHA });
      if (href.endsWith(`/repos/owner/a/tarball/${SHA}`)) return new Response(tarball);
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const read = createGhHandoffSource({ token: "test-token", fetch: fakeFetch });
    const snapshot = await read({ repo: "owner/a", ref: "main" });
    expect(snapshot.sha).toBe(SHA);
    expect([...snapshot.files.keys()].sort()).toEqual(["AGENTS.md", "README.md", "hq/x.ts", "package.json"]);
    expect(snapshot.files.get("AGENTS.md")).toBe("# Charter");
    expect(seen.map((row) => row.auth)).toEqual(["Bearer test-token", "Bearer test-token"]);
  });

  it("refuses a ref the API does not resolve to a full sha", async () => {
    const fakeFetch = (async () => Response.json({ sha: "nope" })) as unknown as typeof fetch;
    const read = createGhHandoffSource({ token: "t", fetch: fakeFetch });
    await expect(read({ repo: "owner/a", ref: null })).rejects.toThrow(/bad_sha/);
  });
});
