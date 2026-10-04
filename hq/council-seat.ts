import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { runCeo, type CeoCall } from "../gateway/client.ts";
import { VerdictSchema } from "../kernel/schemas.ts";
import type { Verdict } from "../kernel/types.ts";
import { loadCodexLogin, storeCodexLogin } from "./codex-login.ts";

const SEAT_MAX_SECONDS = 300;

export const CRITIC_PACKET = [
  "Diff:",
  "function greet(name) { return 'hello ' + name.toUpperCase(); }",
  "Checker: no tests. name may be null.",
].join("\n");

export function councilVerdictSchema(): {
  type: "object";
  additionalProperties: false;
  required: ["result", "actions"];
  properties: {
    result: { type: "string"; enum: ["pass", "changes", "discuss"] };
    actions: { type: "array"; items: { type: "string" } };
  };
} {
  return {
    type: "object",
    additionalProperties: false,
    required: ["result", "actions"],
    properties: {
      result: { type: "string", enum: ["pass", "changes", "discuss"] },
      actions: { type: "array", items: { type: "string" } },
    },
  };
}

export function criticPrompt(packet: string): string {
  return [
    "You are the Critic seat.",
    "Review only this packet for bugs, edge cases, and correctness.",
    "Return only the schema. result is pass, changes, or discuss.",
    "actions is a list of concrete fixes. Do not invent files that are not in the packet.",
    "Packet:",
    packet,
  ].join(" ");
}

export function parseCouncilVerdict(value: unknown): Verdict {
  return VerdictSchema.parse(value);
}

export function ceoVersionFromSheet(sheetText: string): string {
  const raw = parse(sheetText) as { ceo?: { version?: string } };
  const model = raw.ceo?.version;
  if (!model) throw new Error("ceo_version_missing");
  return model;
}

export function councilSeatCall(input: {
  model: string;
  prompt: string;
  schemaPath: string;
  outputPath: string;
}): CeoCall {
  return {
    model: input.model,
    effort: "medium",
    prompt: input.prompt,
    schemaPath: input.schemaPath,
    outputPath: input.outputPath,
    codexBin: "vendor/codex/codex",
    home: "/tmp",
    disableTools: true,
  };
}

export async function runCriticSeat(input: {
  sheetText: string;
  packet: string;
  dbUrl: string;
}): Promise<Verdict> {
  const model = ceoVersionFromSheet(input.sheetText);
  const dir = mkdtempSync(join(tmpdir(), "dexter-council-"));
  const outputPath = join(dir, "out.json");
  const schemaPath = join(dir, "verdict.json");
  writeFileSync(schemaPath, JSON.stringify(councilVerdictSchema()));
  if (!input.dbUrl) throw new Error("codex_login_missing");
  const loginKind = await loadCodexLogin(input.dbUrl);
  if (loginKind !== "chatgpt") {
    throw new Error(loginKind === "api_key" ? "codex_login_not_chatgpt" : "codex_login_unknown");
  }
  const started = Date.now();
  let runError: unknown;
  let parsed: Verdict | null = null;
  try {
    const raw = await runCeo(councilSeatCall({ model, prompt: criticPrompt(input.packet), schemaPath, outputPath }), () => {}, {
      deadline: started + (SEAT_MAX_SECONDS - 10) * 1000,
    });
    parsed = parseCouncilVerdict(raw);
  } catch (error) {
    runError = error;
  }
  try {
    await storeCodexLogin(input.dbUrl);
  } catch (error) {
    if (!runError) runError = error;
  }
  if (runError) throw runError;
  if (!parsed) throw new Error("verdict_missing");
  return parsed;
}
