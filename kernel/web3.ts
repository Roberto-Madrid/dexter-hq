/**
 * Web3 crew rules: testnet only. Pure: no I/O. The workers mirror holds the same lists in workers/web3/chains.json for
 * the shell guard the publish workflow runs; a unit test keeps the two identical.
 */
export const WEB3_CREW = "web3";
export const WEB3_COUNCIL_MODE = "adversarial";
export const WEB3_TIER = "T3";
/** Approval card action that lets HQ dispatch the publish job for one repo, sha and chain. */
export const WEB3_PUBLISH_ACTION = "web3_publish";
/** Approval card action for the owner gate between the mechanism note and the Contracts lane. */
export const WEB3_MECHANISM_ACTION = "web3_mechanism";
/** Anvil's chain: simulations only, never a publish target. */
export const LOCAL_CHAIN_ID = 31337;

/** The only chains a publish may target. RPCs are public endpoints with no key in the URL. */
export const TESTNET_CHAINS: Readonly<Record<string, { name: string; rpc: string }>> = {
  "11155111": { name: "sepolia", rpc: "https://ethereum-sepolia-rpc.publicnode.com" },
  "560048": { name: "hoodi", rpc: "https://ethereum-hoodi-rpc.publicnode.com" },
  "84532": { name: "base-sepolia", rpc: "https://sepolia.base.org" },
  "11155420": { name: "op-sepolia", rpc: "https://sepolia.optimism.io" },
  "421614": { name: "arbitrum-sepolia", rpc: "https://sepolia-rollup.arbitrum.io/rpc" },
  "80002": { name: "polygon-amoy", rpc: "https://rpc-amoy.polygon.technology" },
};

/** Mainnets named so a refusal says why. Anything not on the testnet list is refused either way. */
export const KNOWN_MAINNET_CHAIN_IDS: readonly number[] = [
  1, 10, 56, 100, 130, 137, 146, 250, 252, 324, 480, 1101, 1135, 5000, 8453, 34443, 42161, 42170, 42220, 43114, 59144,
  81457, 534352, 7777777,
];

export type ChainCheck =
  | { ok: true; chainId: number; name: string; rpc: string }
  | { ok: false; reason: "invalid_chain_id" | "mainnet_chain" | "local_chain_not_publishable" | "not_testnet_chain"; chainId: number | null };

/** Decides whether a publish may target `raw`. Only allowlisted testnets pass; mainnets and unknown ids fail closed. */
export function checkPublishChain(raw: unknown): ChainCheck {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^[1-9][0-9]{0,12}$/.test(text)) return { ok: false, reason: "invalid_chain_id", chainId: null };
  const chainId = Number(text);
  if (KNOWN_MAINNET_CHAIN_IDS.includes(chainId)) return { ok: false, reason: "mainnet_chain", chainId };
  if (chainId === LOCAL_CHAIN_ID) return { ok: false, reason: "local_chain_not_publishable", chainId };
  const testnet = TESTNET_CHAINS[text];
  if (!testnet) return { ok: false, reason: "not_testnet_chain", chainId };
  return { ok: true, chainId, name: testnet.name, rpc: testnet.rpc };
}

/** The approval card target for one publish: an approval never carries over to another repo, commit, or chain. */
export function publishTarget(repo: string, sha: string, chainId: number): string {
  return `${repo}@${sha.toLowerCase()}#${chainId}`;
}

export function parsePublishTarget(target: string): { repo: string; sha: string; chainId: string } | null {
  const match = target.match(/^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([0-9a-f]{40})#([0-9]+)$/);
  return match ? { repo: match[1]!, sha: match[2]!, chainId: match[3]! } : null;
}

/** The last recorded Council result for a request, as the connector logs it. */
export type CouncilRecord = { status: string; mode: string; result: string | null; missingSeats: string[] };

export type PublishGateInput = {
  crew: string | null;
  repo: string | null;
  sha: string;
  chainId: unknown;
  approval: { status: string; action: string; target: string; requestId: string | null } | null;
  requestId: string;
  council: CouncilRecord | null;
};

export type PublishGate =
  | { ok: true; chainId: number; chain: string; target: string }
  | { ok: false; reason: string; [key: string]: unknown };

/**
 * Publishing needs, in order: a web3 request with a repo, a full sha, an allowlisted testnet, the owner's approved
 * `web3_publish` card for exactly this repo, sha and chain, and a complete adversarial Council pass.
 */
export function web3PublishGate(input: PublishGateInput): PublishGate {
  if (input.crew !== WEB3_CREW) return { ok: false, reason: "not_web3_request" };
  if (!input.repo) return { ok: false, reason: "repo_required" };
  if (!/^[0-9a-f]{40}$/i.test(input.sha)) return { ok: false, reason: "sha_required" };
  const chain = checkPublishChain(input.chainId);
  if (!chain.ok) return { ok: false, reason: chain.reason, chainId: chain.chainId };
  const target = publishTarget(input.repo, input.sha, chain.chainId);
  const approval = input.approval;
  if (
    !approval ||
    approval.action !== WEB3_PUBLISH_ACTION ||
    approval.requestId !== input.requestId ||
    approval.target !== target
  ) {
    return { ok: false, reason: "publish_approval_required", action: WEB3_PUBLISH_ACTION, target };
  }
  if (approval.status !== "approved") return { ok: false, reason: "publish_not_approved", approvalStatus: approval.status, target };
  const council = input.council;
  if (!council || council.mode !== WEB3_COUNCIL_MODE || council.status !== "verdict" || council.result !== "pass") {
    return {
      ok: false,
      reason: "adversarial_council_pass_required",
      council: council ? { status: council.status, mode: council.mode, result: council.result, missingSeats: council.missingSeats } : null,
    };
  }
  return { ok: true, chainId: chain.chainId, chain: chain.name, target };
}
