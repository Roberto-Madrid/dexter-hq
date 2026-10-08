import { describe, expect, it } from "vitest";
import { decideApproval } from "../../hq/approval.ts";
import { callConnectorTool, type ConnectorDeps } from "../../hq/connector.ts";
import { WEB3_WORKFLOW, createGhWeb3Publisher, type Web3Publisher } from "../../hq/web3-publish.ts";
import type { Verdict } from "../../kernel/types.ts";
import { WEB3_MECHANISM_ACTION, WEB3_PUBLISH_ACTION, publishTarget } from "../../kernel/web3.ts";
import { OWNER, capsAuth as auth, capsDeps } from "./caps-fixtures.ts";

const NOW = "2026-10-08T12:00:00.000Z";
const SHA = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const REQ = "req-web3";
const REPO = "owner/a";

function seats() {
  const calls: string[] = [];
  // Every seat that runs says pass, so only a missing seat can keep the review from passing.
  const run = async (input: { seat: string }): Promise<Verdict> => {
    calls.push(input.seat);
    return { result: "pass", actions: [] };
  };
  return { run, calls };
}

function fakePublisher() {
  const dispatched: unknown[] = [];
  const publisher: Web3Publisher = {
    async dispatch(input) {
      dispatched.push(input);
      return { dispatched: true, workflow: WEB3_WORKFLOW, hostRepo: "owner/workers", runName: "x" };
    },
  };
  return { publisher, dispatched };
}

async function setup() {
  const runner = seats();
  const ctx = await capsDeps({ now: () => NOW, runCouncilSeat: runner.run });
  await ctx.store.saveRequest({
    id: REQ,
    ownerId: OWNER,
    goal: "Prototype an escrow on a testnet.",
    status: "running",
    card: { crew: "web3", tier: "T3", councilMode: "adversarial", newScreen: false, requiresDesignApproval: false },
    evidence: [],
    assignedBotId: auth.id,
    repo: REPO,
    notices: [],
  });
  const pub = fakePublisher();
  const deps: ConnectorDeps = { ...ctx.deps, web3Publisher: pub.publisher };
  const call = (name: string, args: Record<string, unknown>) => callConnectorTool(deps, auth, name, args);
  async function approved(action: string, target: string) {
    const card = await call("request_approval", { action, target, requestId: REQ });
    expect(card.structuredContent.status, JSON.stringify(card.structuredContent)).toBe("pending");
    const approvalId = String(card.structuredContent.approvalId);
    await decideApproval(ctx.store, { approvalId, decision: "approved", now: () => NOW });
    return approvalId;
  }
  return { ...ctx, deps, call, approved, calls: runner.calls, dispatched: pub.dispatched };
}

describe("web3 crew needs the adversarial Council", () => {
  it("refuses a lighter Council mode on a web3 request", async () => {
    const { call, calls } = await setup();
    for (const mode of ["quick", "standard"]) {
      const result = await call("request_council", { requestId: REQ, packet: "Diff: escrow", mode });
      expect(result.structuredContent).toMatchObject({ status: "refused", reason: "crew_requires_adversarial", required: "adversarial" });
    }
    expect(calls).toEqual([]);
  });

  it("an adversarial review comes back incomplete while Devil has no backend; Devil is never asked or faked", async () => {
    const { call, calls } = await setup();
    const result = await call("request_council", { requestId: REQ, packet: "Diff: escrow" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "incomplete", mode: "adversarial", missingSeats: ["devil"] });
    const devil = (result.structuredContent.seats as { seat: string; status: string; reason?: string }[]).find((seat) => seat.seat === "devil");
    expect(devil).toEqual({ seat: "devil", status: "not-ready", reason: "devil_backend_unavailable" });
    expect(calls).not.toContain("devil");
    expect(calls).toEqual(["architect", "strategist", "critic", "security"]);
  });

  it("a web3 request cannot be marked done until the adversarial Council passes", async () => {
    const { call } = await setup();
    await call("request_council", { requestId: REQ, packet: "Diff: escrow" });
    const done = await call("update_request", { requestId: REQ, status: "done", evidence: ["checker:sha:" + SHA] });
    expect(done.structuredContent).toMatchObject({
      status: "refused",
      reason: "done_requires_adversarial_council",
      council: { status: "incomplete", missingSeats: ["devil"] },
    });
  });
});

describe("owner gate before the Contracts lane", () => {
  it("contracts launches need an approved web3_mechanism card; research does not", async () => {
    const { call, approved, cursor } = await setup();
    const base = { brief: "Write the escrow contracts.", requestId: REQ, repo: REPO };
    const refused = await call("launch_agent", { ...base, role: "contracts", idempotencyKey: "c1" });
    expect(refused.structuredContent).toMatchObject({ status: "refused", reason: "web3_mechanism_approval_required" });
    const research = await call("launch_agent", { ...base, role: "researcher", idempotencyKey: "r1" });
    expect(research.structuredContent.status).toBe("launched");
    const approvalId = await approved(WEB3_MECHANISM_ACTION, REQ);
    const ok = await call("launch_agent", { ...base, role: "contracts", idempotencyKey: "c2", approvalId });
    expect(ok.structuredContent).toMatchObject({ status: "launched", persona: "contracts" });
    expect(cursor.starts.at(-1)?.brief).toContain("Persona contract (contracts)");
  });
});

describe("publishing needs an approval card, a testnet, and a passing adversarial Council", () => {
  it("refuses a web3_publish card for a mainnet chain or a malformed target", async () => {
    const { call } = await setup();
    const mainnet = await call("request_approval", { action: WEB3_PUBLISH_ACTION, target: publishTarget(REPO, SHA, 1), requestId: REQ });
    expect(mainnet.structuredContent).toMatchObject({ status: "refused", reason: "mainnet_chain" });
    const bad = await call("request_approval", { action: WEB3_PUBLISH_ACTION, target: "owner/a main", requestId: REQ });
    expect(bad.structuredContent).toMatchObject({ status: "refused", reason: "invalid_publish_target" });
    const otherRepo = await call("request_approval", { action: WEB3_PUBLISH_ACTION, target: publishTarget("owner/b", SHA, 11155111), requestId: REQ });
    expect(otherRepo.structuredContent).toMatchObject({ status: "refused", reason: "publish_target_repo_mismatch" });
  });

  it("request_publish refuses mainnet, a missing card, and an incomplete Council; nothing is dispatched", async () => {
    const { call, approved, dispatched } = await setup();
    const mainnet = await call("request_publish", { requestId: REQ, sha: SHA, chainId: 1 });
    expect(mainnet.structuredContent).toMatchObject({ status: "refused", reason: "mainnet_chain" });
    const noCard = await call("request_publish", { requestId: REQ, sha: SHA, chainId: 11155111 });
    expect(noCard.structuredContent).toMatchObject({
      status: "refused",
      reason: "publish_approval_required",
      target: publishTarget(REPO, SHA, 11155111),
    });
    const approvalId = await approved(WEB3_PUBLISH_ACTION, publishTarget(REPO, SHA, 11155111));
    const wrongChain = await call("request_publish", { requestId: REQ, sha: SHA, chainId: 84532, approvalId });
    expect(wrongChain.structuredContent).toMatchObject({ reason: "publish_approval_required" });
    const noCouncil = await call("request_publish", { requestId: REQ, sha: SHA, chainId: 11155111, approvalId });
    expect(noCouncil.structuredContent).toMatchObject({ reason: "adversarial_council_pass_required", council: null });
    await call("request_council", { requestId: REQ, packet: "Diff: escrow" });
    const incomplete = await call("request_publish", { requestId: REQ, sha: SHA, chainId: 11155111, approvalId });
    expect(incomplete.structuredContent).toMatchObject({
      status: "refused",
      reason: "adversarial_council_pass_required",
      council: { status: "incomplete", mode: "adversarial", missingSeats: ["devil"] },
    });
    expect(dispatched).toEqual([]);
  });

  it("request_publish refuses a request outside the web3 crew", async () => {
    const { call } = await setup();
    const result = await call("request_publish", { requestId: "req-0-0", sha: SHA, chainId: 11155111 });
    expect(result.structuredContent).toMatchObject({ status: "refused", reason: "not_web3_request" });
  });
});

describe("publish dispatcher", () => {
  it("dispatches the pinned web3 workflow from the trusted ref with publish on", async () => {
    const seen: { url: string; body: unknown; auth: string | null }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const publisher = createGhWeb3Publisher({ token: "t-test", hostRepo: "owner/workers", fetchImpl });
    const out = await publisher.dispatch({ repo: REPO, sha: SHA, chainId: 11155111, nonce: "n1", approvalId: "ap-1" });
    expect(seen).toEqual([
      {
        url: "https://api.github.com/repos/owner/workers/actions/workflows/web3.yml/dispatches",
        auth: "Bearer t-test",
        body: {
          ref: "main",
          inputs: { target_repo: REPO, target_sha: SHA, chain_id: "11155111", nonce: "n1", publish: true, approval_id: "ap-1" },
        },
      },
    ]);
    expect(out).toMatchObject({ dispatched: true, workflow: "web3.yml", runName: `dexter-web3 ${REPO} ${SHA} 11155111 n1` });
  });

  it("refuses to dispatch a mainnet chain even if called directly", async () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const publisher = createGhWeb3Publisher({ token: "t", hostRepo: "owner/workers", fetchImpl });
    await expect(publisher.dispatch({ repo: REPO, sha: SHA, chainId: 1, nonce: "n", approvalId: "a" })).rejects.toThrow(/mainnet_chain/);
  });
});
