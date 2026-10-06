import type { ConnectorRequest } from "./connector-store.ts";

export const PINNED_CHECKER_WORKFLOW = "checker.yml";
export const PINNED_CHECKER_PATH = `.github/workflows/${PINNED_CHECKER_WORKFLOW}`;
export const PINNED_CHECKS = ["build", "lint", "playwright"] as const;
export const TRUSTED_CHECKER_REF = "main";

export type CheckerDispatchInput = {
  repo: string;
  sha: string;
  branch?: string | null;
  pullRequest?: string | null;
};

export type CheckerDispatchResult = {
  dispatched: boolean;
  githubRunId: string | null;
  sha: string;
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
  outcome(input: { githubRunId: string; sha: string }): Promise<CheckerOutcome>;
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

export function checkerRunName(sha: string): string {
  return `dexter-checker ${sha}`;
}

export function workflowPathIsPinned(path: unknown): boolean {
  const value = typeof path === "string" ? path : "";
  return value === PINNED_CHECKER_WORKFLOW || value === PINNED_CHECKER_PATH || value.endsWith(`/${PINNED_CHECKER_WORKFLOW}`);
}

export function recordedGithubRunId(evidence: readonly string[]): string | null {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const row = evidence[i];
    if (row.startsWith("checker:github_run:")) {
      const id = row.slice("checker:github_run:".length).trim();
      if (id) return id;
    }
  }
  return null;
}

export function matchPinnedCheckerRun(
  run: Record<string, unknown>,
  expected: { githubRunId: string; sha: string },
): boolean {
  if (String(run.id ?? "") !== expected.githubRunId) return false;
  if (!workflowPathIsPinned(run.path)) return false;
  if (String(run.name ?? "") !== checkerRunName(expected.sha)) return false;
  return true;
}

export function findDispatchedCheckerRun(
  runs: Record<string, unknown>[],
  expected: { sha: string; sinceMs: number },
): Record<string, unknown> | null {
  const name = checkerRunName(expected.sha);
  const matched = runs.filter((run) => {
    if (!workflowPathIsPinned(run.path)) return false;
    if (String(run.name ?? "") !== name) return false;
    const created = Date.parse(String(run.created_at ?? ""));
    if (Number.isNaN(created) || created < expected.sinceMs) return false;
    return true;
  });
  matched.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  return matched[0] ?? null;
}

export function evidenceFromOutcome(input: {
  workflow: string;
  sha: string;
  repo: string;
  hostRepo: string;
  githubRunId: string | null;
  outcome: CheckerOutcome;
}): string[] {
  const rows = [
    `checker:workflow:${input.workflow}`,
    `checker:repo:${input.repo}`,
    `checker:host:${input.hostRepo}`,
    `checker:sha:${input.sha}`,
  ];
  if (input.githubRunId) rows.push(`checker:github_run:${input.githubRunId}`);
  if (input.outcome.conclusion) rows.push(`checker:conclusion:${input.outcome.conclusion}`);
  rows.push(`checker:state:${input.outcome.state}`);
  for (const item of PINNED_CHECKS) {
    const hit = input.outcome.evidence.find((row) => row === `checker:${item}:pass` || row === `checker:${item}:fail`);
    rows.push(hit ?? `checker:${item}:pinned`);
  }
  return [...rows, ...input.outcome.evidence.filter((item) => !rows.includes(item))];
}

export function checksMoveRequestReady(outcome: CheckerOutcome): boolean {
  return outcome.state === "completed" && outcome.conclusion === "success";
}

export function applyCheckEvidence(
  request: ConnectorRequest,
  evidence: string[],
  ready: boolean,
): ConnectorRequest {
  const merged = [...request.evidence];
  for (const item of evidence) {
    if (!merged.includes(item)) merged.push(item);
  }
  const next: ConnectorRequest = { ...request, evidence: merged };
  if (ready && next.status !== "done" && next.status !== "cancelled" && next.status !== "failed") {
    next.status = "ready_for_review";
  } else if (!ready && (next.status === "queued" || next.status === "running")) {
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
    evidence: [
      `checker:github_run:${githubRunId}`,
      `checker:sha:${sha}`,
      ...(html ? [`checker:url:${html}`] : []),
    ],
  };
}

export function createGhChecker(options: {
  token: string;
  hostRepo: string;
  trustedRef?: string;
  fetchImpl?: FetchLike;
  apiBase?: string;
  now?: () => number;
}): CheckerGateway {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? "https://api.github.com";
  const hostRepo = options.hostRepo;
  const trustedRef = options.trustedRef ?? TRUSTED_CHECKER_REF;
  const now = options.now ?? (() => Date.now());
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

  return {
    async dispatch(input) {
      const sinceMs = now() - 2000;
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
            },
          }),
        },
      );
      if (response.status >= 300) throw new Error(`checker_dispatch_${response.status}`);
      const runs = await listWorkflowRuns();
      const match = findDispatchedCheckerRun(runs, { sha: input.sha, sinceMs });
      const githubRunId = match ? String(match.id ?? "") || null : null;
      return {
        dispatched: true,
        githubRunId,
        sha: input.sha,
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
      if (!matchPinnedCheckerRun(run, { githubRunId: input.githubRunId, sha: input.sha })) {
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
