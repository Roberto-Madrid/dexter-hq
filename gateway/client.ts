/**
 * Path B CEO client. Spawns the local Codex CLI, which uses the ChatGPT login
 * already on disk. This file never reads, logs, or accepts that login.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type CeoEffort = "low" | "medium";

export type CeoCall = {
  model: string;
  effort: CeoEffort;
  prompt: string;
  schemaPath?: string;
  outputPath: string;
  codexBin: string;
  home?: string;
  disableTools?: boolean;
};

export type CeoEvent = {
  type: string;
  text?: string;
  usage?: Record<string, number>;
  itemType?: string;
  model?: string;
  effort?: string;
};

export type RunCeoOptions = {
  deadline?: number;
  onStage?: (stage: string, ms: number) => void;
};

// Codex refuses to create helper binaries when CODEX_HOME is inside the process
// temp dir. HOME stays /tmp, and this sibling is not a parent of /tmp/.codex.
const CODEX_TMPDIR = "/tmp/dexter-codex-tmp";
const DEFAULT_BUDGET_MS = 290_000;

const DISABLED_TOOLS = [
  "shell_tool",
  "search_tool",
  "standalone_web_search",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "image_generation",
];

const MODEL_KEYS = new Set(["model", "model_id", "modelId"]);
const EFFORT_KEYS = new Set(["reasoning_effort", "reasoningEffort", "effort"]);
const NEST_SKIP = new Set(["text", "message", "prompt", "error"]);

export function ceoCommand(call: CeoCall): { args: string[]; env: NodeJS.ProcessEnv } {
  const home = call.home ?? process.env.HOME ?? "/tmp";
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-m",
    call.model,
    "-c",
    `model_reasoning_effort="${call.effort}"`,
    "-o",
    call.outputPath,
  ];
  if (call.disableTools) {
    args.push("--ignore-user-config", "--ignore-rules", "-c", 'web_search="disabled"');
    for (const name of DISABLED_TOOLS) args.push("--disable", name);
  }
  if (call.schemaPath) args.push("--output-schema", call.schemaPath);
  args.push(call.prompt);
  return {
    args,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      TMPDIR: CODEX_TMPDIR,
      TMP: CODEX_TMPDIR,
      TEMP: CODEX_TMPDIR,
      USER: "dexter",
      LANG: process.env.LANG ?? "C.UTF-8",
    } as unknown as NodeJS.ProcessEnv,
  };
}

export function commandPath(bin: string): string {
  return isAbsolute(bin) ? bin : resolve(bin);
}

export function redactSecrets(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bAGE-SECRET-KEY-1[A-Z2-7]+\b/g, "[REDACTED]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[db]");
}

export function runCeo(
  call: CeoCall,
  onEvent: (event: CeoEvent, atMs: number) => void,
  options: RunCeoOptions = {},
): Promise<unknown> {
  const { args, env } = ceoCommand(call);
  mkdirSync(CODEX_TMPDIR, { recursive: true, mode: 0o700 });

  const started = Date.now();
  const deadline = options.deadline ?? started + DEFAULT_BUDGET_MS;
  const stages: Record<string, number> = {};
  const mark = (stage: string) => {
    if (stages[stage] !== undefined) return;
    const ms = Date.now() - started;
    stages[stage] = ms;
    options.onStage?.(stage, ms);
  };

  let child;
  try {
    // An open stdin pipe makes Codex wait for a prompt. ignore is /dev/null, so it sees EOF.
    child = spawn(commandPath(call.codexBin), args, {
      cwd: mkdtempSync(join(tmpdir(), "dexter-ceo-")),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = redactSecrets(error instanceof Error ? error.message : "spawn_error").slice(0, 300);
    return Promise.reject(new Error(`spawn_error ${detail}`));
  }
  mark("spawn");

  const stdout = child.stdout;
  const stderrStream = child.stderr;
  if (!stdout || !stderrStream) {
    child.kill("SIGKILL");
    return Promise.reject(new Error("spawn_error"));
  }

  let card: unknown = null;
  let failMessage: string | null = null;
  let stderr = "";
  let deadlineHit = false;
  let spawnFailed: string | null = null;

  const lines = createInterface({ input: stdout });
  lines.on("line", (line) => {
    const event = parseEvent(line);
    onEvent(event, Date.now() - started);
    if (event.type === "thread.started") mark("thread");
    else if (event.type === "turn.started") mark("turn");
    else if (event.type === "turn.failed" || event.type === "error") {
      failMessage = event.text || event.type;
    } else if (event.type === "item.completed" && event.itemType === "agent_message" && event.text) {
      try {
        card = JSON.parse(event.text) as unknown;
        mark("card");
      } catch {
        failMessage = failMessage ?? "card_parse";
      }
    }
  });

  stderrStream.setEncoding("utf8");
  stderrStream.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 16_000) stderr = stderr.slice(-8_000);
  });

  const timer = setTimeout(() => {
    deadlineHit = true;
    child.kill("SIGKILL");
  }, Math.max(0, deadline - Date.now()));

  return new Promise((resolve, reject) => {
    let settled = false;
    let sawExit = false;
    let stdoutClosed = false;
    let exitCode: number | null = null;

    const finish = () => {
      if (settled || !sawExit || !stdoutClosed) return;
      settled = true;
      clearTimeout(timer);
      mark("exit");
      const tail = redactSecrets(stderr).slice(-4_000);
      if (spawnFailed) {
        reject(new Error(`spawn_error ${spawnFailed}`));
        return;
      }
      if (deadlineHit) {
        const stuck = stageThatStalled(stages);
        const duration = Date.now() - started - (stages[stuck] ?? 0);
        reject(new Error(`deadline stage=${stuck} duration_ms=${duration} ${tail}`.trim()));
        return;
      }
      if (exitCode === 0 && card !== null) {
        resolve(card);
        return;
      }
      if (failMessage) {
        reject(new Error(`${redactSecrets(failMessage).slice(0, 500)} ${tail}`.trim()));
        return;
      }
      reject(new Error(`codex_exit_${exitCode ?? "unknown"} ${tail}`.trim()));
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnFailed = redactSecrets(error.message).slice(0, 300);
      child.kill("SIGKILL");
    });
    lines.on("close", () => {
      stdoutClosed = true;
      finish();
    });
    child.on("close", (code) => {
      sawExit = true;
      exitCode = code;
      finish();
    });
  });
}

function stageThatStalled(stages: Record<string, number>): string {
  const order = ["card", "turn", "thread", "spawn"];
  for (const stage of order) {
    if (stages[stage] !== undefined) return stage;
  }
  return "spawn";
}

function parseEvent(line: string): CeoEvent {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const type = String(value.type ?? "unknown");
    const item = value.item && typeof value.item === "object" ? (value.item as Record<string, unknown>) : {};
    const itemType = typeof item.type === "string" ? item.type : undefined;
    const text = textOf(item) ?? textOf(value) ?? failureText(value);
    const identity = { model: undefined as string | undefined, effort: undefined as string | undefined };
    scanIdentity(value, 0, identity);
    const rawUsage = value.usage && typeof value.usage === "object" ? (value.usage as Record<string, unknown>) : undefined;
    const usage: Record<string, number> = {};
    if (rawUsage) {
      for (const [key, itemValue] of Object.entries(rawUsage)) {
        if (typeof itemValue === "number") usage[key] = itemValue;
      }
    }
    return {
      type,
      text,
      itemType,
      model: identity.model,
      effort: identity.effort,
      usage: Object.keys(usage).length ? usage : undefined,
    };
  } catch {
    return { type: "unparsed" };
  }
}

function textOf(value: Record<string, unknown>): string | undefined {
  return typeof value.text === "string" ? value.text : undefined;
}

function failureText(value: Record<string, unknown>): string | undefined {
  if (typeof value.message === "string") return value.message;
  const error = value.error;
  if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") {
    return (error as Record<string, unknown>).message as string;
  }
  return undefined;
}

function scanIdentity(
  value: unknown,
  depth: number,
  found: { model?: string; effort?: string },
): void {
  if (depth > 4 || !value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (MODEL_KEYS.has(key) && typeof item === "string" && item.length < 100 && !item.includes("eyJ")) found.model = item;
    else if (EFFORT_KEYS.has(key) && typeof item === "string" && /^(none|minimal|low|medium|high|xhigh|max)$/.test(item)) {
      found.effort = item;
    } else if (!NEST_SKIP.has(key)) scanIdentity(item, depth + 1, found);
  }
}
