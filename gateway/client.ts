/**
 * Path B CEO client. Spawns the local Codex CLI, which uses the ChatGPT login
 * already on disk. This file never reads, logs, or accepts that login.
 */
import { spawn } from "node:child_process";
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
};

// Codex refuses to create helper binaries when CODEX_HOME is inside the process
// temp dir. HOME stays /tmp, and this sibling is not a parent of /tmp/.codex.
const CODEX_TMPDIR = "/tmp/dexter-codex-tmp";

const DISABLED_TOOLS = [
  "shell_tool",
  "search_tool",
  "standalone_web_search",
  "web_search_request",
  "web_search_cached",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "image_generation",
];

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
    args.push("--ignore-user-config", "--ignore-rules");
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
    },
  };
}

export function commandPath(bin: string): string {
  return isAbsolute(bin) ? bin : resolve(bin);
}

export function runCeo(call: CeoCall, onEvent: (event: CeoEvent, atMs: number) => void): Promise<number> {
  const { args, env } = ceoCommand(call);
  mkdirSync(CODEX_TMPDIR, { recursive: true, mode: 0o700 });

  const started = Date.now();
  const child = spawn(commandPath(call.codexBin), args, {
    cwd: mkdtempSync(join(tmpdir(), "dexter-ceo-")),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(parseEvent(line), Date.now() - started);
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim()) onEvent(parseEvent(buffer), Date.now() - started);
      if (code === 0) resolve(0);
      else {
        const detail = stderr.replace(/\s+/g, " ").replace(/eyJ[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 180);
        reject(new Error(`codex_exit_${code ?? "unknown"} ${detail}`));
      }
    });
  });
}

function parseEvent(line: string): CeoEvent {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const type = String(value.type ?? "unknown");
    const item = value.item && typeof value.item === "object" ? (value.item as Record<string, unknown>) : {};
    const text = typeof item.text === "string" ? item.text : typeof value.text === "string" ? value.text : undefined;
    const rawUsage = value.usage && typeof value.usage === "object" ? (value.usage as Record<string, unknown>) : undefined;
    const usage: Record<string, number> = {};
    if (rawUsage) {
      for (const [key, itemValue] of Object.entries(rawUsage)) {
        if (typeof itemValue === "number") usage[key] = itemValue;
      }
    }
    return { type, text, usage: Object.keys(usage).length ? usage : undefined };
  } catch {
    return { type: "unparsed" };
  }
}
