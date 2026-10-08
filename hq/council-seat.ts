import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { runCeo, type CeoCall } from "../gateway/client.ts";
import { VerdictSchema } from "../kernel/schemas.ts";
import type { Verdict } from "../kernel/types.ts";
import { resolveCodexBin } from "./codex-bin.ts";
import { loadCodexLogin, storeCodexLogin } from "./codex-login.ts";
import { loadPersonas } from "./personas.ts";

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

/** The Council seats in the master plan's order (docs/MASTER_PLAN_V6.md §5). Each has a persona file in personas/. */
export const COUNCIL_SEATS = ["architect", "strategist", "critic", "security", "devil"] as const;
export type CouncilSeatId = (typeof COUNCIL_SEATS)[number];

const SEAT_FOCUS: Record<CouncilSeatId, string> = {
  architect: "Review for structure, coupling, and debt.",
  strategist: "Review for approach, completeness, and fit with the goal.",
  critic: "Review for bugs, edge cases, and correctness.",
  security: "Review for auth, injection, secrets, and dependency risk.",
  devil: "Attack the consensus and find the strongest reason not to ship.",
};

function seatTitle(seat: CouncilSeatId): string {
  return seat.charAt(0).toUpperCase() + seat.slice(1);
}

function readPersonas(): Map<string, string> {
  try {
    return loadPersonas();
  } catch {
    return new Map();
  }
}

/** One seat's prompt: its persona contract and the packet. Seats never see each other's verdicts. */
export function seatPrompt(seat: CouncilSeatId, packet: string, personas: Map<string, string> = readPersonas()): string {
  const persona = (personas.get(seat) ?? SEAT_FOCUS[seat]).replace(/^#.*\n+/, "").trim();
  return [
    `You are the ${seatTitle(seat)} seat on the Council.`,
    `Persona contract: ${persona}`,
    "Review only this packet. You do not see the other seats' verdicts.",
    "Return only the schema. result is pass, changes, or discuss.",
    "actions is a list of concrete fixes. Do not invent files that are not in the packet.",
    "Packet:",
    packet,
  ].join(" ");
}

export function criticPrompt(packet: string): string {
  return seatPrompt("critic", packet);
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
  codexBin: string;
}): CeoCall {
  return {
    model: input.model,
    effort: "medium",
    prompt: input.prompt,
    schemaPath: input.schemaPath,
    outputPath: input.outputPath,
    codexBin: input.codexBin,
    home: "/tmp",
    disableTools: true,
  };
}

export type CouncilSession = {
  runSeat(seat: CouncilSeatId, packet: string): Promise<Verdict>;
  /** Writes the (possibly refreshed) login back. Call once, after the last seat. */
  close(): Promise<void>;
};

/**
 * Opens one path-B review: resolves the verified codex binary and reads the login once; seats then run one after
 * another under one shared deadline, and close() writes the login back once (docs/MASTER_PLAN_V6.md §8.1).
 */
export async function openCouncilSession(input: {
  sheetText: string;
  dbUrl: string;
  resolveCodex?: () => Promise<string>;
}): Promise<CouncilSession> {
  const model = ceoVersionFromSheet(input.sheetText);
  if (!input.dbUrl) throw new Error("codex_login_missing");
  // Fail closed before the login is decrypted: no verified binary, no seat.
  const codexBin = await (input.resolveCodex ?? resolveCodexBin)();
  const loginKind = await loadCodexLogin(input.dbUrl, codexBin);
  if (loginKind !== "chatgpt") {
    throw new Error(loginKind === "api_key" ? "codex_login_not_chatgpt" : "codex_login_unknown");
  }
  const deadline = Date.now() + (SEAT_MAX_SECONDS - 10) * 1000;
  const personas = readPersonas();
  return {
    async runSeat(seat, packet) {
      const dir = mkdtempSync(join(tmpdir(), "dexter-council-"));
      const outputPath = join(dir, "out.json");
      const schemaPath = join(dir, "verdict.json");
      writeFileSync(schemaPath, JSON.stringify(councilVerdictSchema()));
      const raw = await runCeo(councilSeatCall({ model, prompt: seatPrompt(seat, packet, personas), schemaPath, outputPath, codexBin }), () => {}, {
        deadline,
      });
      return parseCouncilVerdict(raw);
    },
    async close() {
      await storeCodexLogin(input.dbUrl);
    },
  };
}

export async function runCriticSeat(input: {
  sheetText: string;
  packet: string;
  dbUrl: string;
  resolveCodex?: () => Promise<string>;
}): Promise<Verdict> {
  const session = await openCouncilSession(input);
  let runError: unknown;
  let parsed: Verdict | null = null;
  try {
    parsed = await session.runSeat("critic", input.packet);
  } catch (error) {
    runError = error;
  }
  try {
    await session.close();
  } catch (error) {
    if (!runError) runError = error;
  }
  if (runError) throw runError;
  if (!parsed) throw new Error("verdict_missing");
  return parsed;
}
