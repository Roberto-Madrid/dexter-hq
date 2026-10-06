import type { ConnectorRequest } from "./connector-store.ts";

export const PINNED_CHECKER_WORKFLOW = "checker.yml";
export const PINNED_CHECKS = ["build", "lint", "playwright"] as const;

export type CheckerDispatchInput = {
  repo: string;
  ref: string;
  runId: string;
  sha?: string | null;
  pullRequest?: string | null;
};

export type CheckerDispatchResult = {
  dispatched: boolean;
  runId: string;
  sha: string | null;
  url: string | null;
  workflow: string;
};

export type CheckerOutcome = {
  state: "queued" | "in_progress" | "completed" | "unknown";
  conclusion: "success" | "failure" | "cancelled" | "neutral" | null;
  evidence: string[];
};

export type CheckerGateway = {
  dispatch(input: CheckerDispatchInput): Promise<CheckerDispatchResult>;
  outcome(input: { repo: string; runId: string }): Promise<CheckerOutcome>;
};

type FetchLike = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function checksConfigured(env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env): boolean {
  const token = typeof env.GH_HQ_TOKEN === "string" ? env.GH_HQ_TOKEN.trim() : "";
  return Boolean(token);
}

export function evidenceFromOutcome(input: {
  workflow: string;
  sha: string | null;
  repo: string;
  ref: string;
  outcome: CheckerOutcome;
}): string[] {
  const rows = [
    `checker:workflow:${input.workflow}`,
    `checker:repo:${input.repo}`,
    `checker:ref:${input.ref}`,
  ];
  if (input.sha) rows.push(`checker:sha:${input.sha}`);
  if (input.outcome.conclusion) rows.push(`checker:conclusion:${input.outcome.conclusion}`);
  rows.push(`checker:state:${input.outcome.state}`);
  for (const item of PINNED_CHECKS) {
    const hit = input.outcome.evidence.find((row) => row.includes(item));
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

export function createGhChecker(options: {
  token: string;
  fetchImpl?: FetchLike;
  apiBase?: string;
}): CheckerGateway {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? "https://api.github.com";
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  return {
    async dispatch(input) {
      const response = await fetchImpl(
        `${apiBase}/repos/${input.repo}/actions/workflows/${PINNED_CHECKER_WORKFLOW}/dispatches`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            ref: input.ref,
            inputs: { run_id: input.runId },
          }),
        },
      );
      if (response.status >= 300) throw new Error(`checker_dispatch_${response.status}`);
      return {
        dispatched: true,
        runId: input.runId,
        sha: input.sha ?? null,
        url: `${apiBase}/repos/${input.repo}/actions/workflows/${PINNED_CHECKER_WORKFLOW}`,
        workflow: PINNED_CHECKER_WORKFLOW,
      };
    },
    async outcome(input) {
      const response = await fetchImpl(`${apiBase}/repos/${input.repo}/actions/runs?per_page=20`, { headers });
      if (response.status >= 300) {
        return { state: "unknown", conclusion: null, evidence: [`checker:list:${response.status}`] };
      }
      const body = asRecord(await response.json());
      const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs.map(asRecord) : [];
      const match = runs.find((item) => String(item.name ?? "").includes(input.runId));
      if (!match) return { state: "queued", conclusion: null, evidence: [`checker:run:${input.runId}`] };
      const status = String(match.status ?? "queued");
      const conclusion = match.conclusion == null ? null : String(match.conclusion);
      const state =
        status === "completed" || status === "in_progress" || status === "queued" ? status : "unknown";
      const parsedConclusion =
        conclusion === "success" || conclusion === "failure" || conclusion === "cancelled" || conclusion === "neutral"
          ? conclusion
          : null;
      const html = typeof match.html_url === "string" ? match.html_url : null;
      return {
        state,
        conclusion: parsedConclusion,
        evidence: [
          `checker:run:${match.id ?? input.runId}`,
          ...(html ? [`checker:url:${html}`] : []),
        ],
      };
    },
  };
}
