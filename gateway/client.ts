/**
 * Path B CEO client. Spawns the local Codex CLI, which uses the ChatGPT login
 * already on disk. This file never reads, logs, or accepts that login.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CeoEffort = "low" | "medium";

export type CeoCall = {
  model: string;
  effort: CeoEffort;
  prompt: string;
  schemaPath?: string;
  outputPath: string;
  codexBin: string;
};

export type CeoEvent = {
  type: string;
  text?: string;
  usage?: Record<string, number>;
};

function scrubbedEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: process.env.LANG ?? "C.UTF-8",
  };
}

export function runCeo(call: CeoCall, onEvent: (event: CeoEvent, atMs: number) => void): Promise<number> {
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
  if (call.schemaPath) args.push("--output-schema", call.schemaPath);
  args.push(call.prompt);

  const started = Date.now();
  const child = spawn(call.codexBin, args, {
    cwd: mkdtempSync(join(tmpdir(), "dexter-ceo-")),
    env: scrubbedEnv(),
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
