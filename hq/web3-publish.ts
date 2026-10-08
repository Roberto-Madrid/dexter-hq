/**
 * Web3 crew wiring for the connector: the adversarial Council requirement, the owner gate before the Contracts lane,
 * web3 approval cards, and request_publish, which dispatches the workers publish job only when kernel/web3.ts's
 * publish gate passes. HQ never holds or sees the deployer key; it lives only in the workers publish job.
 */
import { randomUUID } from "node:crypto";
import type { ConnectorAuth, ConnectorRequest, ConnectorStore } from "./connector-store.ts";
import { normalizeAction } from "./token-police.ts";
import {
  WEB3_COUNCIL_MODE,
  WEB3_CREW,
  WEB3_MECHANISM_ACTION,
  WEB3_PUBLISH_ACTION,
  checkPublishChain,
  parsePublishTarget,
  web3PublishGate,
  type CouncilRecord,
} from "../kernel/web3.ts";

export const WEB3_WORKFLOW = "web3.yml";
export const WEB3_TRUSTED_REF = "main";
const COUNCIL_LOOKBACK = 20;

type Body = Record<string, unknown> & { status: string };
export type Web3Outcome = { body: Body; isError: boolean; target: string };

export type Web3DispatchInput = { repo: string; sha: string; chainId: number; nonce: string; approvalId: string };
export type Web3Dispatch = { dispatched: true; workflow: string; hostRepo: string; runName: string };
export type Web3Publisher = { dispatch(input: Web3DispatchInput): Promise<Web3Dispatch> };

export function isWeb3Request(request: ConnectorRequest | null): boolean {
  return request?.card?.crew === WEB3_CREW;
}

export function web3RunName(input: { repo: string; sha: string; chainId: number; nonce: string }): string {
  return `dexter-web3 ${input.repo} ${input.sha} ${input.chainId} ${input.nonce}`;
}

/** Dispatches the pinned workers web3.yml from the trusted ref with publish on. Refuses a non-testnet chain itself too. */
export function createGhWeb3Publisher(options: {
  token: string;
  hostRepo: string;
  trustedRef?: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}): Web3Publisher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? "https://api.github.com";
  const trustedRef = options.trustedRef ?? WEB3_TRUSTED_REF;
  return {
    async dispatch(input) {
      const chain = checkPublishChain(input.chainId);
      if (!chain.ok) throw new Error(`web3_dispatch_refused:${chain.reason}`);
      const response = await fetchImpl(`${apiBase}/repos/${options.hostRepo}/actions/workflows/${WEB3_WORKFLOW}/dispatches`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          ref: trustedRef,
          inputs: {
            target_repo: input.repo,
            target_sha: input.sha,
            chain_id: String(chain.chainId),
            nonce: input.nonce,
            publish: true,
            approval_id: input.approvalId,
          },
        }),
      });
      if (response.status >= 300) throw new Error(`web3_dispatch_${response.status}`);
      return { dispatched: true, workflow: WEB3_WORKFLOW, hostRepo: options.hostRepo, runName: web3RunName(input) };
    },
  };
}

/**
 * The request's latest Council review that ran (verdict or incomplete); refusals and errors do not count.
 * dexter-shortcut: the review is not bound to a commit, so a pass on an earlier sha would cover a later publish;
 * upgrade path: record the reviewed sha in request_council and require it to equal the sha being published.
 */
export async function lastCouncilRecord(store: ConnectorStore, request: ConnectorRequest): Promise<CouncilRecord | null> {
  const events = await store.listRecentEvents("request_council", { target: request.id, limit: COUNCIL_LOOKBACK });
  for (const event of events) {
    const r = event.result;
    if (event.ownerId !== request.ownerId || !r || (r.status !== "verdict" && r.status !== "incomplete")) continue;
    return {
      status: String(r.status),
      mode: typeof r.mode === "string" ? r.mode : "",
      result: typeof r.result === "string" ? r.result : null,
      missingSeats: Array.isArray(r.missingSeats) ? r.missingSeats.map(String) : [],
    };
  }
  return null;
}

function councilPassed(council: CouncilRecord | null): boolean {
  return Boolean(council && council.status === "verdict" && council.mode === WEB3_COUNCIL_MODE && council.result === "pass");
}

function councilSummary(council: CouncilRecord | null) {
  return council ? { status: council.status, mode: council.mode, result: council.result, missingSeats: council.missingSeats } : null;
}

/** request_council on a web3 request runs adversarial or not at all. */
export function web3CouncilModeRefusal(request: ConnectorRequest | null, mode: string): Body | null {
  if (!isWeb3Request(request) || mode === WEB3_COUNCIL_MODE) return null;
  return { status: "refused", reason: "crew_requires_adversarial", required: WEB3_COUNCIL_MODE, mode };
}

/**
 * update_request done on a web3 request needs a complete adversarial pass. While the Devil seat has no backend every
 * adversarial review is incomplete, so this refuses every web3 request; that is deliberate.
 */
export async function web3DoneRefusal(store: ConnectorStore, request: ConnectorRequest): Promise<Body | null> {
  if (!isWeb3Request(request)) return null;
  // dexter-shortcut: the Devil seat has no backend (SEAT_BACKEND_UNAVAILABLE in hq/connector.ts), so every adversarial
  // review is incomplete and no web3 request can be marked done or published; upgrade path: give Devil a backend on a
  // second provider, and this gate and request_publish open with no change here.
  const council = await lastCouncilRecord(store, request);
  if (councilPassed(council)) return null;
  return { status: "refused", reason: "done_requires_adversarial_council", requestId: request.id, council: councilSummary(council) };
}

/** The owner gate: a Contracts launch on a web3 request needs an approved web3_mechanism card for that request. */
export async function web3LaunchRefusal(
  store: ConnectorStore,
  request: ConnectorRequest | null,
  role: string,
  approvalId: string | null,
): Promise<Body | null> {
  if (!isWeb3Request(request) || role !== "contracts") return null;
  const approval = approvalId ? await store.getApproval(approvalId) : null;
  const ok =
    approval &&
    approval.ownerId === request!.ownerId &&
    normalizeAction(approval.action) === WEB3_MECHANISM_ACTION &&
    approval.requestId === request!.id &&
    approval.status === "approved";
  if (ok) return null;
  return { status: "refused", reason: "web3_mechanism_approval_required", action: WEB3_MECHANISM_ACTION, requestId: request!.id };
}

/** request_approval for a web3 action: the card must name a web3 request, and a publish card an exact testnet target. */
export async function web3ApprovalRefusal(
  store: ConnectorStore,
  input: { action: string; target: string; requestId: string | null },
): Promise<Body | null> {
  const action = normalizeAction(input.action);
  if (action !== WEB3_PUBLISH_ACTION && action !== WEB3_MECHANISM_ACTION) return null;
  const request = input.requestId ? await store.getRequest(input.requestId) : null;
  if (!isWeb3Request(request)) return { status: "refused", reason: "not_web3_request", action };
  if (action === WEB3_MECHANISM_ACTION) return null;
  const parsed = parsePublishTarget(input.target);
  if (!parsed) return { status: "refused", reason: "invalid_publish_target", expected: "<owner/repo>@<40-hex sha>#<chainId>" };
  const chain = checkPublishChain(parsed.chainId);
  if (!chain.ok) return { status: "refused", reason: chain.reason, chainId: chain.chainId };
  if (parsed.repo !== request!.repo) return { status: "refused", reason: "publish_target_repo_mismatch", repo: request!.repo };
  return null;
}

const text = (args: Record<string, unknown>, ...names: string[]): string | null => {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
};

/**
 * request_publish: dispatch the workers publish job for one web3 request, sha and testnet chain. Refused unless the
 * publish gate passes (approved card for this exact target, complete adversarial Council pass). One dispatch per card.
 */
export async function requestPublish(
  deps: { store: ConnectorStore; web3Publisher?: Web3Publisher | null },
  auth: ConnectorAuth,
  args: Record<string, unknown>,
): Promise<Web3Outcome> {
  const requestId = text(args, "requestId", "request_id");
  const request = requestId ? await deps.store.getRequest(requestId) : null;
  const refuse = (body: Record<string, unknown>): Web3Outcome => ({
    body: { status: "refused", ...body, requestId } as Body,
    isError: true,
    target: requestId ?? "missing",
  });
  if (!request || request.ownerId !== auth.ownerId) return refuse({ reason: "unknown_request" });
  if (!isWeb3Request(request)) return refuse({ reason: "not_web3_request" });
  if (auth.kind !== "ceo" && request.assignedBotId !== auth.id) return refuse({ reason: "not_own_request" });
  if (request.repo && auth.kind !== "ceo" && !auth.repos.includes(request.repo)) return refuse({ reason: "repo_out_of_scope" });
  const sha = (text(args, "sha") ?? "").toLowerCase();
  const approvalId = text(args, "approvalId", "approval_id");
  const approval = approvalId ? await deps.store.getApproval(approvalId) : null;
  const gate = web3PublishGate({
    crew: String(request.card?.crew ?? ""),
    repo: request.repo,
    sha,
    chainId: args.chainId ?? args.chain_id,
    requestId: request.id,
    approval:
      approval && approval.ownerId === auth.ownerId
        ? { status: approval.status, action: normalizeAction(approval.action), target: approval.target, requestId: approval.requestId }
        : null,
    council: await lastCouncilRecord(deps.store, request),
  });
  if (!gate.ok) return refuse({ ...gate, ok: undefined });
  const used = await deps.store.listRecentEvents("request_publish", { target: request.id, limit: 50 });
  if (used.some((event) => event.result?.status === "dispatched" && event.result?.approvalId === approvalId)) {
    return refuse({ reason: "approval_already_used", approvalId });
  }
  if (!deps.web3Publisher) {
    return { body: { status: "not-configured", reason: "web3_publisher_unavailable", requestId }, isError: true, target: request.id };
  }
  const nonce = randomUUID();
  try {
    const out = await deps.web3Publisher.dispatch({ repo: request.repo!, sha, chainId: gate.chainId, nonce, approvalId: approvalId! });
    return {
      body: { status: "dispatched", requestId, approvalId, chainId: gate.chainId, chain: gate.chain, sha, nonce, ...out },
      isError: false,
      target: request.id,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 120) : "dispatch_failed";
    return { body: { status: "error", reason, requestId }, isError: true, target: request.id };
  }
}
