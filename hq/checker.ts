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

export type RequestBinding = { pullRequest: string | null; branch: string | null };

/** One changed path from GitHub's compare API. Never the patch. */
export type CompareFile = { filename: string; status: string; additions: number; deletions: number };
/** `truncated` is true when GitHub hit its 300-file list limit, so the real count is at least that. */
export type CompareResult = { files: CompareFile[]; aheadBy: number | null; truncated: boolean };

export type CheckerGateway = {
  dispatch(input: CheckerDispatchInput): Promise<CheckerDispatchResult>;
  find(input: { repo: string; sha: string; nonce: string }): Promise<string | null>;
  outcome(input: { githubRunId: string; repo: string; sha: string; nonce: string }): Promise<CheckerOutcome>;
  /** Current head commit of the request's PR or branch on GitHub. Throws when both are set, or returns null/throws when unknown. */
  head?(input: { repo: string } & RequestBinding): Promise<string | null>;
  /**
   * Verifies a bot-chosen binding before it is stored: does the PR (and is it open) or branch exist in `repo`?
   * `exists: false` means GitHub says it is not in that repo. Throws when GitHub cannot answer, so callers fail closed.
   */
  bindingState?(input: { repo: string } & RequestBinding): Promise<BindingState>;
  /** Changed paths between `base` and `head` (GitHub compare, three dots). Throws when unknown, so callers fail closed. */
  compare?(input: { repo: string; base: string; head: string }): Promise<CompareResult>;
};

export type BindingState = { exists: boolean; open: boolean; head: string | null };

const BRANCH_CHARS = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * git check-ref-format rules for a branch name, on a conservative charset (no space, ~ ^ : ? * [ \ @ or controls):
 * no empty, `.` or `..` segment, no segment starting with `.` or ending with `.lock`, no `..` anywhere,
 * no leading `/` or `-`, no trailing `/` or `.`, and not `HEAD`.
 */
export function isValidBranchName(name: string): boolean {
  if (!BRANCH_CHARS.test(name)) return false;
  if (name === "HEAD" || name.startsWith("-") || name.endsWith(".") || name.includes("..")) return false;
  return name.split("/").every((segment) => segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".lock"));
}

export type BindingRefusal = "invalid_binding" | "binding_pr_and_branch";

/**
 * Reads a PR number or branch name from tool args. Missing fields are null; malformed ones are invalid.
 * A request binds to a PR or a branch, never both.
 */
export function bindingFromArgs(
  args: Record<string, unknown>,
): { ok: true; binding: RequestBinding } | { ok: false; reason: BindingRefusal } {
  const rawPr = args.pullRequest ?? args.pull_request;
  const rawBranch = args.branch;
  let pullRequest: string | null = null;
  let branch: string | null = null;
  if (rawPr !== undefined && rawPr !== null && rawPr !== "") {
    const text = String(rawPr).trim().replace(/^#/, "");
    if (!/^[1-9][0-9]{0,9}$/.test(text)) return { ok: false, reason: "invalid_binding" };
    pullRequest = text;
  }
  if (rawBranch !== undefined && rawBranch !== null && rawBranch !== "") {
    if (typeof rawBranch !== "string" || !isValidBranchName(rawBranch)) return { ok: false, reason: "invalid_binding" };
    branch = rawBranch;
  }
  if (pullRequest && branch) return { ok: false, reason: "binding_pr_and_branch" };
  return { ok: true, binding: { pullRequest, branch } };
}

/** Rows written before the PR-xor-branch rule may carry both; nothing may pick one of them silently. */
export function bindingIsAmbiguous(request: { pullRequest?: string | null; branch?: string | null }): boolean {
  return Boolean(request.pullRequest && request.branch);
}

export function sameSha(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export function requestIsBound(request: { pullRequest?: string | null; branch?: string | null }): boolean {
  return Boolean(request.pullRequest || request.branch);
}

/** A bound request keeps its PR/branch: any supplied field must match what is stored. */
export function bindingMatches(request: { pullRequest?: string | null; branch?: string | null }, supplied: RequestBinding): boolean {
  if (!requestIsBound(request)) return true;
  if (supplied.pullRequest && supplied.pullRequest !== (request.pullRequest ?? null)) return false;
  if (supplied.branch && supplied.branch !== (request.branch ?? null)) return false;
  return true;
}

type FetchLike = typeof fetch;

/** A hung GitHub head lookup must not hold update_request open; a timeout throws, and done fails closed. */
export const HEAD_LOOKUP_TIMEOUT_MS = 10_000;
/** Same budget for the token police diff lookup; a timeout throws and the approval is refused. */
export const COMPARE_TIMEOUT_MS = 10_000;
/** GitHub's compare API lists at most this many changed files. */
const COMPARE_FILE_LIMIT = 300;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

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
    if (hit) rows.push(hit);
  }
  return [...rows, ...input.outcome.evidence.filter((item) => !rows.includes(item) && !item.startsWith("checker:github_run:"))];
}

export function checksMoveRequestReady(outcome: CheckerOutcome): boolean {
  return outcome.state === "completed" && outcome.conclusion === "success";
}

export function checkerPassedCurrentSha(request: ConnectorRequest): boolean {
  const run = request.checkRun;
  return Boolean(run?.passed && run.sha && run.githubRunId);
}

/**
 * Folds a Checker outcome into the request. `check.head` is the request's bound PR/branch head on GitHub
 * (null when unbound or unknown): only a pass on that exact sha may set ready_for_review.
 */
export function applyCheckEvidence(
  request: ConnectorRequest,
  evidence: string[],
  ready: boolean,
  check: { sha: string; repo: string; head: string | null },
): ConnectorRequest {
  const merged = sanitizeBotEvidence([...request.evidence]);
  for (const item of sanitizeBotEvidence(evidence)) {
    if (!merged.includes(item)) merged.push(item);
  }
  const next: ConnectorRequest = { ...request, evidence: merged };
  const shaChanged = Boolean(request.checkRun && request.checkRun.sha !== check.sha);
  const readyOnHead = ready && sameSha(check.head, check.sha);
  if (readyOnHead && next.status !== "done" && next.status !== "cancelled" && next.status !== "failed") {
    next.status = "ready_for_review";
  } else if (shaChanged && next.status === "ready_for_review") {
    next.status = "verifying";
  } else if (!readyOnHead && (next.status === "queued" || next.status === "running" || next.status === "ready_for_review")) {
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
  headTimeoutMs?: number;
  compareTimeoutMs?: number;
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
    async head(input) {
      if (bindingIsAmbiguous(input)) throw new Error("binding_ambiguous");
      const path = input.pullRequest
        ? `pulls/${encodeURIComponent(input.pullRequest)}`
        : input.branch
          ? `git/ref/heads/${input.branch.split("/").map(encodeURIComponent).join("/")}`
          : null;
      if (!path) return null;
      const response = await fetchImpl(`${apiBase}/repos/${input.repo}/${path}`, {
        headers,
        signal: AbortSignal.timeout(options.headTimeoutMs ?? HEAD_LOOKUP_TIMEOUT_MS),
      });
      if (response.status >= 300) throw new Error(`head_lookup_${response.status}`);
      const body = asRecord(await response.json());
      const sha = input.pullRequest ? asRecord(body.head).sha : asRecord(body.object).sha;
      return typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
    },
    async bindingState(input) {
      if (bindingIsAmbiguous(input)) throw new Error("binding_ambiguous");
      const path = input.pullRequest
        ? `pulls/${encodeURIComponent(input.pullRequest)}`
        : input.branch
          ? `git/ref/heads/${input.branch.split("/").map(encodeURIComponent).join("/")}`
          : null;
      if (!path) throw new Error("binding_missing");
      const response = await fetchImpl(`${apiBase}/repos/${input.repo}/${path}`, {
        headers,
        signal: AbortSignal.timeout(options.headTimeoutMs ?? HEAD_LOOKUP_TIMEOUT_MS),
      });
      if (response.status === 404) return { exists: false, open: false, head: null };
      if (response.status >= 300) throw new Error(`binding_lookup_${response.status}`);
      const body = asRecord(await response.json());
      const shaOf = (value: unknown) => (typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null);
      if (input.pullRequest) {
        const baseRepo = asRecord(asRecord(body.base).repo).full_name;
        if (typeof baseRepo !== "string" || baseRepo.toLowerCase() !== input.repo.toLowerCase()) {
          return { exists: false, open: false, head: null };
        }
        return { exists: true, open: body.state === "open", head: shaOf(asRecord(body.head).sha) };
      }
      if (body.ref !== `refs/heads/${input.branch}`) return { exists: false, open: false, head: null };
      return { exists: true, open: true, head: shaOf(asRecord(body.object).sha) };
    },
    async compare(input) {
      // per_page=1 trims the commit list; the file list (up to 300) always comes on the first page.
      const response = await fetchImpl(`${apiBase}/repos/${input.repo}/compare/${input.base}...${input.head}?per_page=1`, {
        headers,
        signal: AbortSignal.timeout(options.compareTimeoutMs ?? COMPARE_TIMEOUT_MS),
      });
      if (response.status >= 300) throw new Error(`compare_${response.status}`);
      const body = asRecord(await response.json());
      if (!Array.isArray(body.files)) throw new Error("compare_unreadable");
      const files = body.files.map(asRecord).flatMap((file) =>
        typeof file.filename === "string" && file.filename
          ? [{ filename: file.filename, status: String(file.status ?? "modified"), additions: count(file.additions), deletions: count(file.deletions) }]
          : [],
      );
      return { files, aheadBy: typeof body.ahead_by === "number" ? body.ahead_by : null, truncated: files.length >= COMPARE_FILE_LIMIT };
    },
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
