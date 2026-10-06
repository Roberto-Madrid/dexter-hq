import type { ConnectorRequest } from "./connector-store.ts";

export const PINNED_CHECKER_WORKFLOW = "checker.yml";
export const PINNED_CHECKER_PATH = `.github/workflows/${PINNED_CHECKER_WORKFLOW}`;
export const PINNED_CHECKS = ["build", "lint", "playwright"] as const;
export const TRUSTED_CHECKER_REF = "main";

export type CheckerDispatchInput = {
  repo: string;
  sha: string;
  nonce: string;
  branch?: string | null;
  pullRequest?: string | null;
};

export type CheckerDispatchResult = {
  dispatched: boolean;
  githubRunId: string | null;
  sha: string;
  nonce: string;
  url: string | null;
  workflow: string;
  hostRepo: string;
  trustedRef: string;
};

export type CheckerOutcome = {
  state: "queued" | "in_progress" | "completed" | "unknown";
  conclusion: "success" | "failure" | "cancelled" | "neutral" | null;
  githubRunId: string | null;
  evidence: string[];
};

export type CheckerGateway = {
  dispatch(input: CheckerDispatchInput): Promise<CheckerDispatchResult>;
  find(input: { repo: string; sha: string; nonce: string }): Promise<string | null>;
  outcome(input: { githubRunId: string; repo: string; sha: string; nonce: string }): Promise<CheckerOutcome>;
};

type FetchLike = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function checksConfigured(env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env): boolean {
  const token = typeof env.GH_HQ_TOKEN === "string" ? env.GH_HQ_TOKEN.trim() : "";
  const host = typeof env.GH_WORKERS_REPO === "string" ? env.GH_WORKERS_REPO.trim() : "";
  return Boolean(token && host);
}

export function checkerRunName(input: { repo: string; sha: string; nonce: string }): string {
  return `dexter-checker ${input.repo} ${input.sha} ${input.nonce}`;
}

export function workflowPathIsPinned(path: unknown): boolean {
  return path === PINNED_CHECKER_PATH;
}

export function sanitizeBotEvidence(items: readonly string[]): string[] {
  return items.filter((item) => !item.startsWith("checker:github_run:"));
}

export function matchPinnedCheckerRun(
  run: Record<string, unknown>,
  expected: { githubRunId?: string; repo: string; sha: string; nonce: string; trustedRef?: string },
): boolean {
  if (expected.githubRunId && String(run.id ?? "") !== expected.githubRunId) return false;
  if (!workflowPathIsPinned(run.path)) return false;
  if (run.event !== "workflow_dispatch") return false;
  if (String(run.head_branch ?? "") !== (expected.trustedRef ?? TRUSTED_CHECKER_REF)) return false;
  if (String(run.name ?? "") !== checkerRunName(expected)) return false;
  return true;
}

export function findDispatchedCheckerRun(
  runs: Record<string, unknown>[],
  expected: { repo: string; sha: string; nonce: string; trustedRef?: string },
): Record<string, unknown> | null {
  const matched = runs.filter((run) => matchPinnedCheckerRun(run, expected));
  matched.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  return matched[0] ?? null;
}

export function evidenceFromOutcome(input: {
  workflow: string;
  sha: string;
  repo: string;
  hostRepo: string;
  nonce: string;
  githubRunId: string | null;
  outcome: CheckerOutcome;
}): string[] {
  const rows = [
    `checker:workflow:${input.workflow}`,
    `checker:repo:${input.repo}`,
    `checker:host:${input.hostRepo}`,
    `checker:sha:${input.sha}`,
    `checker:nonce:${input.nonce}`,
  ];
  if (input.outcome.conclusion) rows.push(`checker:conclusion:${input.outcome.conclusion}`);
  rows.push(`checker:state:${input.outcome.state}`);
  for (const item of PINNED_CHECKS) {
    const hit = input.outcome.evidence.find((row) => row === `checker:${item}:pass` || row === `checker:${item}:fail`);
    rows.push(hit ?? `checker:${item}:pinned`);
  }
  return [...rows, ...input.outcome.evidence.filter((item) => !rows.includes(item) && !item.startsWith("checker:github_run:"))];
}

export function checksMoveRequestReady(outcome: CheckerOutcome): boolean {
  return outcome.state === "completed" && outcome.conclusion === "success";
}

export function applyCheckEvidence(
  request: ConnectorRequest,
  evidence: string[],
  ready: boolean,
  check: { sha: string; repo: string },
): ConnectorRequest {
  const merged = sanitizeBotEvidence([...request.evidence]);
  for (const item of sanitizeBotEvidence(evidence)) {
    if (!merged.includes(item)) merged.push(item);
  }
  const next: ConnectorRequest = { ...request, evidence: merged };
  const shaChanged = Boolean(request.checkRun && request.checkRun.sha !== check.sha);
  if (ready && next.status !== "done" && next.status !== "cancelled" && next.status !== "failed") {
    next.status = "ready_for_review";
  } else if (shaChanged && next.status === "ready_for_review") {
    next.status = "verifying";
  } else if (!ready && (next.status === "queued" || next.status === "running" || next.status === "ready_for_review")) {
    next.status = "verifying";
  }
  return next;
}

function parseConclusion(value: unknown): CheckerOutcome["conclusion"] {
  if (value === "success" || value === "failure" || value === "cancelled" || value === "neutral") return value;
  return null;
}

function parseState(value: unknown): CheckerOutcome["state"] {
  if (value === "completed" || value === "in_progress" || value === "queued") return value;
  return "unknown";
}

function outcomeFromRun(run: Record<string, unknown>, sha: string): CheckerOutcome {
  const githubRunId = String(run.id ?? "");
  const html = typeof run.html_url === "string" ? run.html_url : null;
  return {
    state: parseState(run.status),
    conclusion: parseConclusion(run.conclusion),
    githubRunId,
    evidence: [`checker:sha:${sha}`, ...(html ? [`checker:url:${html}`] : [])],
  };
}

export function createGhChecker(options: {
  token: string;
  hostRepo: string;
  trustedRef?: string;
  fetchImpl?: FetchLike;
  apiBase?: string;
  findAttempts?: number;
}): CheckerGateway {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? "https://api.github.com";
  const hostRepo = options.hostRepo;
  const trustedRef = options.trustedRef ?? TRUSTED_CHECKER_REF;
  const findAttempts = Math.max(1, options.findAttempts ?? 3);
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function listWorkflowRuns(): Promise<Record<string, unknown>[]> {
    const response = await fetchImpl(
      `${apiBase}/repos/${hostRepo}/actions/workflows/${PINNED_CHECKER_WORKFLOW}/runs?per_page=20`,
      { headers },
    );
    if (response.status >= 300) return [];
    const body = asRecord(await response.json());
    return Array.isArray(body.workflow_runs) ? body.workflow_runs.map(asRecord) : [];
  }

  async function find(input: { repo: string; sha: string; nonce: string }): Promise<string | null> {
    for (let attempt = 0; attempt < findAttempts; attempt += 1) {
      const runs = await listWorkflowRuns();
      const match = findDispatchedCheckerRun(runs, { ...input, trustedRef });
      if (match?.id != null && String(match.id)) return String(match.id);
    }
    return null;
  }

  return {
    find,
    async dispatch(input) {
      const existing = await find(input);
      if (existing) {
        return {
          dispatched: false,
          githubRunId: existing,
          sha: input.sha,
          nonce: input.nonce,
          url: `${apiBase}/repos/${hostRepo}/actions/runs/${existing}`,
          workflow: PINNED_CHECKER_WORKFLOW,
          hostRepo,
          trustedRef,
        };
      }
      const response = await fetchImpl(
        `${apiBase}/repos/${hostRepo}/actions/workflows/${PINNED_CHECKER_WORKFLOW}/dispatches`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            ref: trustedRef,
            inputs: {
              target_repo: input.repo,
              target_sha: input.sha,
              nonce: input.nonce,
            },
          }),
        },
      );
      if (response.status >= 300) throw new Error(`checker_dispatch_${response.status}`);
      const githubRunId = await find(input);
      return {
        dispatched: true,
        githubRunId,
        sha: input.sha,
        nonce: input.nonce,
        url: githubRunId ? `${apiBase}/repos/${hostRepo}/actions/runs/${githubRunId}` : null,
        workflow: PINNED_CHECKER_WORKFLOW,
        hostRepo,
        trustedRef,
      };
    },
    async outcome(input) {
      const response = await fetchImpl(`${apiBase}/repos/${hostRepo}/actions/runs/${input.githubRunId}`, { headers });
      if (response.status >= 300) {
        return {
          state: "unknown",
          conclusion: null,
          githubRunId: input.githubRunId,
          evidence: [`checker:get:${response.status}`],
        };
      }
      const run = asRecord(await response.json());
      if (!matchPinnedCheckerRun(run, { ...input, trustedRef, githubRunId: input.githubRunId })) {
        return {
          state: "unknown",
          conclusion: null,
          githubRunId: input.githubRunId,
          evidence: ["checker:mismatch"],
        };
      }
      return outcomeFromRun(run, input.sha);
    },
  };
}
