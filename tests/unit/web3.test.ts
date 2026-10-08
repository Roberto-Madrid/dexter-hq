import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SHIPPED_CREWS, loadCrews } from "../../hq/crews.ts";
import { loadPersonas, personaIdForRole } from "../../hq/personas.ts";
import { validatePlanCard } from "../../kernel/plan-card.ts";
import type { PlanCard } from "../../kernel/types.ts";
import {
  KNOWN_MAINNET_CHAIN_IDS,
  LOCAL_CHAIN_ID,
  TESTNET_CHAINS,
  WEB3_PUBLISH_ACTION,
  checkPublishChain,
  publishTarget,
  web3PublishGate,
  type PublishGateInput,
} from "../../kernel/web3.ts";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const DEPLOYER_SECRET = "TESTNET_DEPLOYER_KEY";
const WORKFLOWS = "workers/.github/workflows";
const WEB3_WORKFLOW = `${WORKFLOWS}/web3.yml`;

type Step = { name?: string; id?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = {
  needs?: string | string[];
  if?: string;
  environment?: string | { name: string };
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  secrets?: unknown;
  steps: Step[];
};
type Workflow = {
  "run-name": string;
  env?: Record<string, string>;
  permissions: Record<string, string>;
  on: { workflow_dispatch: { inputs: Record<string, { required: boolean; type: string }> } };
  jobs: Record<string, Job>;
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "web3-"));
  dirs.push(dir);
  return dir;
}

describe("testnet only", () => {
  it("refuses every known mainnet chain id, including Ethereum, Base and Polygon", () => {
    for (const id of [1, 8453, 137, 10, 42161, ...KNOWN_MAINNET_CHAIN_IDS]) {
      expect(checkPublishChain(id), String(id)).toMatchObject({ ok: false, reason: "mainnet_chain", chainId: id });
    }
  });

  it("allows only the allowlisted testnets, and never the local chain or an unknown id", () => {
    expect(checkPublishChain("11155111")).toMatchObject({ ok: true, chainId: 11155111, name: "sepolia" });
    expect(checkPublishChain(84532)).toMatchObject({ ok: true, name: "base-sepolia" });
    expect(checkPublishChain(LOCAL_CHAIN_ID)).toMatchObject({ ok: false, reason: "local_chain_not_publishable" });
    expect(checkPublishChain(999999)).toMatchObject({ ok: false, reason: "not_testnet_chain" });
    for (const bad of ["", "0", "-1", "0x1", "1e3", "11155111 ", null, undefined, 1.5]) {
      const result = checkPublishChain(bad);
      if (bad === "11155111 ") expect(result.ok).toBe(true);
      else expect(result, String(bad)).toMatchObject({ ok: false });
    }
    for (const rpc of Object.values(TESTNET_CHAINS).map((chain) => chain.rpc)) expect(rpc).toMatch(/^https:\/\/[^@?]+$/);
  });

  it("the shell guard reads the same lists as the kernel", () => {
    const json = JSON.parse(readFileSync("workers/web3/chains.json", "utf8")) as {
      testnets: Record<string, { name: string; rpc: string }>;
      mainnets: number[];
      local: number;
    };
    expect(json.testnets).toEqual(TESTNET_CHAINS);
    expect(json.mainnets).toEqual([...KNOWN_MAINNET_CHAIN_IDS]);
    expect(json.local).toBe(LOCAL_CHAIN_ID);
  });
});

describe("publish gate", () => {
  const base: PublishGateInput = {
    crew: "web3",
    repo: "owner/dapp",
    sha: SHA,
    chainId: 11155111,
    requestId: "req-1",
    approval: { status: "approved", action: WEB3_PUBLISH_ACTION, target: publishTarget("owner/dapp", SHA, 11155111), requestId: "req-1" },
    council: { status: "incomplete", mode: "adversarial", result: "pass", missingSeats: ["devil"] },
  };

  it("refuses mainnet before looking at approvals", () => {
    expect(web3PublishGate({ ...base, chainId: 1 })).toMatchObject({ ok: false, reason: "mainnet_chain" });
  });

  it("needs the owner's approved card for exactly this repo, sha and chain", () => {
    expect(web3PublishGate({ ...base, approval: null })).toMatchObject({ ok: false, reason: "publish_approval_required" });
    const otherChain = { ...base.approval!, target: publishTarget("owner/dapp", SHA, 84532) };
    expect(web3PublishGate({ ...base, approval: otherChain })).toMatchObject({ ok: false, reason: "publish_approval_required" });
    const otherRequest = { ...base.approval!, requestId: "req-2" };
    expect(web3PublishGate({ ...base, approval: otherRequest })).toMatchObject({ ok: false, reason: "publish_approval_required" });
    const pending = { ...base.approval!, status: "pending" };
    expect(web3PublishGate({ ...base, approval: pending })).toMatchObject({ ok: false, reason: "publish_not_approved" });
  });

  it("an incomplete adversarial Council (no Devil backend) never passes", () => {
    expect(web3PublishGate(base)).toMatchObject({
      ok: false,
      reason: "adversarial_council_pass_required",
      council: { status: "incomplete", missingSeats: ["devil"] },
    });
    const standard = { status: "verdict", mode: "standard", result: "pass", missingSeats: [] };
    expect(web3PublishGate({ ...base, council: standard })).toMatchObject({ ok: false, reason: "adversarial_council_pass_required" });
  });

  it("opens only for a complete adversarial pass (reachable once a Devil backend exists)", () => {
    const complete = { status: "verdict", mode: "adversarial", result: "pass", missingSeats: [] };
    expect(web3PublishGate({ ...base, council: complete })).toEqual({
      ok: true,
      chainId: 11155111,
      chain: "sepolia",
      target: publishTarget("owner/dapp", SHA, 11155111),
    });
    expect(web3PublishGate({ ...base, crew: "change", council: complete })).toMatchObject({ ok: false, reason: "not_web3_request" });
  });
});

describe("web3 crew files", () => {
  it("ships a T3 crew that requires the adversarial Council and staffs research, mechanism and contracts", () => {
    expect(SHIPPED_CREWS).toContain("web3");
    const raw = parse(readFileSync("crews/web3.yaml", "utf8")) as { tier: string; council: string; personas: string[]; chains: string };
    expect(raw).toMatchObject({ tier: "T3", council: "adversarial", chains: "testnet_only" });
    const crew = loadCrews().get("web3");
    expect(crew?.tasks.map((task) => [task.persona, task.role, task.dependsOn])).toEqual([
      ["researcher", "researcher", []],
      ["web3", "web3", ["researcher"]],
      ["contracts", "contracts", ["web3"]],
    ]);
    expect(crew?.capabilities).toContain("request_approval");
    const personas = loadPersonas();
    for (const name of ["web3", "contracts"]) {
      expect(personas.get(name), name).toMatch(/^# /);
      expect(personas.get(name)).toMatch(/testnet/i);
    }
    expect(personaIdForRole("contracts")).toBe("contracts");
    expect(personaIdForRole("web3")).toBe("web3");
    expect(personas.get("contracts")).toMatch(/never .*key/i);
    const checklist = readFileSync("checklists/web3-testnet.md", "utf8");
    for (const item of ["mainnet", "adversarial", "approval card", "TESTNET_DEPLOYER_KEY", "anvil", "Devil"]) expect(checklist).toContain(item);
  });

  it("a plan card for web3 is forced to T3 with the adversarial Council", () => {
    const card: PlanCard = {
      crew: "web3",
      personas: ["researcher", "web3", "contracts"],
      councilMode: "quick",
      tier: "T2",
      definitionOfDone: "testnet prototype",
      outOfScope: "mainnet",
      needsOwner: [],
      newScreen: false,
      outwardAction: false,
      requiresDesignApproval: false,
      requiresApproval: false,
    };
    const validated = validatePlanCard(card, SHIPPED_CREWS);
    expect(validated.card).toMatchObject({ crew: "web3", tier: "T3", councilMode: "adversarial" });
    expect(validated.notices).toContain("web3_requires_adversarial_council");
  });
});

describe("web3 workflow secret scoping", () => {
  const text = readFileSync(WEB3_WORKFLOW, "utf8");
  const workflow = parse(text) as Workflow;
  const secretRefs = (value: unknown): string[] => [...JSON.stringify(value ?? null).matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!);

  it("has a test job and a separate publish job", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(["publish", "test"]);
    expect(workflow.on.workflow_dispatch.inputs).toMatchObject({
      target_repo: { required: true },
      target_sha: { required: true },
      chain_id: { required: true },
      nonce: { required: true },
      publish: { type: "boolean" },
      approval_id: { type: "string" },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("only the publish job can read the deployer key, and only in the signing steps' env", () => {
    expect(secretRefs(workflow.env)).toEqual([]);
    expect(text).not.toMatch(/secrets:\s*inherit/);
    expect(secretRefs(workflow.jobs.test)).not.toContain(DEPLOYER_SECRET);
    expect(secretRefs(workflow.jobs.test)).toEqual(["CHECKER_READ_TOKEN"]);
    const publish = workflow.jobs.publish;
    expect(secretRefs(publish.env)).toEqual([]);
    const holders = publish.steps.filter((step) => secretRefs(step).includes(DEPLOYER_SECRET));
    expect(holders.map((step) => step.name)).toEqual(["Deployer address", "Sign and send"]);
    for (const step of holders) {
      expect(secretRefs(step.env)).toEqual([DEPLOYER_SECRET]);
      expect(step.run ?? "").not.toContain("secrets.");
      expect(step.uses).toBeUndefined();
    }
    // Every reference in the whole file sits in one of those two env blocks.
    expect(text.match(new RegExp(`secrets\\.${DEPLOYER_SECRET}`, "g"))).toHaveLength(2);
  });

  it("the publish job runs no target code: no target checkout, no forge, only trusted scripts", () => {
    const publish = workflow.jobs.publish;
    expect(JSON.stringify(publish)).not.toContain("inputs.target_repo");
    expect(publish.steps.some((step) => /\bforge\b/.test(step.run ?? ""))).toBe(false);
    for (const step of publish.steps.filter((item) => item.uses)) {
      expect(step.uses).toMatch(/^(actions\/checkout|actions\/download-artifact|foundry-rs\/foundry-toolchain)@/);
    }
    const checkout = publish.steps.find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout?.with).toMatchObject({ "persist-credentials": false, path: "tools" });
    expect(checkout?.with?.repository).toBeUndefined();
  });

  it("publishing needs the test job, the publish input, an approval id and the protected environment", () => {
    const publish = workflow.jobs.publish;
    expect([publish.needs].flat()).toEqual(["test"]);
    expect(publish.if).toContain("inputs.publish");
    expect(publish.if).toContain("inputs.approval_id != ''");
    expect(publish.environment).toBe("testnet-publish");
    expect(publish.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.test.environment).toBeUndefined();
  });

  it("the guard refuses mainnet before any key is touched, in both jobs", () => {
    for (const name of ["test", "publish"] as const) {
      const steps = workflow.jobs[name].steps;
      const guard = steps.findIndex((step) => step.name === "Chain guard");
      expect(guard, name).toBeGreaterThanOrEqual(0);
      const firstSecret = steps.findIndex((step) => secretRefs(step).length > 0);
      expect(guard, name).toBeLessThan(firstSecret);
    }
  });

  it("no run script interpolates an expression (inputs reach scripts through env only)", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) expect(step.run ?? "", step.name).not.toContain("${{");
    }
  });

  it("no other workflow (agent run, Checker) mentions the deployer key or its environment", () => {
    const others = readdirSync(WORKFLOWS).filter((name) => name !== "web3.yml");
    expect(others).toEqual(expect.arrayContaining(["agent-run.yml", "checker.yml"]));
    for (const name of others) {
      const other = readFileSync(join(WORKFLOWS, name), "utf8");
      expect(other, name).not.toContain(DEPLOYER_SECRET);
      expect(other, name).not.toContain("testnet-publish");
    }
  });
});

/** Runs a mirror script with bash and fake tools on PATH. */
function runScript(script: string, args: string[], env: Record<string, string>, shims: Record<string, string> = {}) {
  const dir = tempDir();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(shims)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const output = join(dir, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script, ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: dir, GITHUB_OUTPUT: output, ...env },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { status: result.status, out: `${result.stdout}${result.stderr}`, outputs, dir };
}

const GUARD = "workers/web3/chain-guard.sh";
const SEND = "workers/web3/send-planned.sh";
const fakeRpc = (hex: string) => `cat <<'JSON'\n{"jsonrpc":"2.0","id":1,"result":"${hex}"}\nJSON`;

describe("chain guard script", () => {
  it("refuses mainnet and unknown ids", () => {
    expect(runScript(GUARD, ["1"], {})).toMatchObject({ status: 1 });
    expect(runScript(GUARD, ["1"], {}).out).toContain("mainnet");
    expect(runScript(GUARD, ["8453"], {}).status).toBe(1);
    expect(runScript(GUARD, ["999999"], {}).out).toContain("not an allowlisted testnet");
    expect(runScript(GUARD, ["0x1"], {}).status).toBe(1);
    expect(runScript(GUARD, ["31337"], {}).status).toBe(1);
  });

  it("allows the local chain only for simulation", () => {
    const local = runScript(GUARD, ["31337"], { ALLOW_LOCAL: "1" });
    expect(local.status).toBe(0);
    expect(local.outputs).toMatchObject({ chain_id: "31337", name: "anvil" });
  });

  it("passes a testnet and checks the live RPC's chain id when asked", () => {
    const plain = runScript(GUARD, ["11155111"], {});
    expect(plain.status).toBe(0);
    expect(plain.outputs).toMatchObject({ chain_id: "11155111", name: "sepolia", rpc_url: TESTNET_CHAINS["11155111"]!.rpc });
    expect(runScript(GUARD, ["11155111"], { CHECK_RPC: "1" }, { curl: fakeRpc("0xaa36a7") }).status).toBe(0);
    const lying = runScript(GUARD, ["11155111"], { CHECK_RPC: "1" }, { curl: fakeRpc("0x1") });
    expect(lying.status).toBe(1);
    expect(lying.out).toContain("RPC reports chain 1");
  });
});

describe("sign-and-send script (publish job)", () => {
  const SENDER = "0x1111111111111111111111111111111111111111";
  function plan(dir: string, txs: Record<string, unknown>[]): string {
    const path = join(dir, "plan.json");
    writeFileSync(path, JSON.stringify({ transactions: txs }));
    return path;
  }
  const create = { transactionType: "CREATE", transaction: { from: SENDER, input: "0x6080", value: "0x0", chainId: "0xaa36a7" } };
  const call = {
    transactionType: "CALL",
    transaction: { from: SENDER, to: "0x2222222222222222222222222222222222222222", input: "0xd09de08a", value: "0x0", chainId: "0xaa36a7" },
  };
  const castShim = (dir: string) => `echo "$@" >> ${join(dir, "cast.log")}\nif [ "$1" = chain-id ]; then echo 11155111; fi`;

  it("signs only planned transactions with cast, from the expected sender, on an allowlisted testnet", () => {
    const dir = tempDir();
    const file = plan(dir, [create, call]);
    const result = runScript(SEND, [file], { CHAIN_ID: "11155111", EXPECTED_SENDER: SENDER, DEPLOYER_KEY: "k-test" }, { cast: castShim(dir) });
    expect(result.status, result.out).toBe(0);
    const log = readFileSync(join(dir, "cast.log"), "utf8").trim().split("\n");
    expect(log[0]).toBe(`chain-id --rpc-url ${TESTNET_CHAINS["11155111"]!.rpc}`);
    expect(log[1]).toContain("send --json --rpc-url");
    expect(log[1]).toContain("--create 0x6080");
    expect(log[2]).toContain("0x2222222222222222222222222222222222222222 0xd09de08a");
    expect(result.out).not.toContain("k-test");
  });

  it("refuses a plan from another sender, for another chain, or for mainnet, sending nothing", () => {
    for (const [txs, env, message] of [
      [[{ ...create, transaction: { ...create.transaction, from: "0x9999999999999999999999999999999999999999" } }], {}, "sender"],
      [[{ ...create, transaction: { ...create.transaction, chainId: "0x1" } }], {}, "chain"],
      [[create], { CHAIN_ID: "1" }, "mainnet"],
      [[], {}, "no transactions"],
    ] as const) {
      const dir = tempDir();
      const file = plan(dir, txs as unknown as Record<string, unknown>[]);
      const result = runScript(SEND, [file], { CHAIN_ID: "11155111", EXPECTED_SENDER: SENDER, DEPLOYER_KEY: "k-test", ...env }, { cast: castShim(dir) });
      expect(result.status, message).not.toBe(0);
      expect(result.out.toLowerCase()).toContain(message);
      const log = existsSync(join(dir, "cast.log")) ? readFileSync(join(dir, "cast.log"), "utf8") : "";
      expect(log).not.toContain("send ");
    }
  });
});
