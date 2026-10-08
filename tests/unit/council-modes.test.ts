import { describe, expect, it } from "vitest";
import { COUNCIL_WEEKLY_SEAT_CAP, callConnectorTool, councilSeatsFor, type CouncilSeatId } from "../../hq/connector.ts";
import { CodexNotReadyError } from "../../hq/codex-bin.ts";
import { COUNCIL_SEATS, seatPrompt } from "../../hq/council-seat.ts";
import { loadPersonas } from "../../hq/personas.ts";
import type { Verdict } from "../../kernel/types.ts";
import { OWNER, BOT, capsAuth as auth, capsDeps } from "./caps-fixtures.ts";

const NOW = "2026-10-08T08:00:00.000Z";
const STANDARD: CouncilSeatId[] = ["architect", "strategist", "critic", "security"];

function seatRunner(verdicts: Partial<Record<CouncilSeatId, Verdict | Error>> = {}) {
  const calls: { seat: CouncilSeatId; packet: string }[] = [];
  const run = async (input: { packet: string; seat: CouncilSeatId }) => {
    calls.push({ seat: input.seat, packet: input.packet });
    const verdict = verdicts[input.seat];
    if (verdict instanceof Error) throw verdict;
    return verdict ?? { result: "pass" as const, actions: [] };
  };
  return { run, calls };
}

async function council(args: Record<string, unknown>, runner = seatRunner(), seed = 0) {
  const ctx = await capsDeps({ now: () => NOW, runCouncilSeat: runner.run });
  for (let n = 0; n < seed; n += 1) {
    await ctx.store.appendEvent({ ownerId: OWNER, actor: "unit-lead", action: "council_seat", target: "old", result: null, at: NOW });
  }
  const before = (await ctx.store.listEventsByAction(["council_seat"])).length;
  const result = await callConnectorTool(ctx.deps, auth, "request_council", { requestId: "req-0-0", packet: "Diff: x", ...args });
  const seatsReserved = (await ctx.store.listEventsByAction(["council_seat"])).length - before;
  return { ...ctx, result, body: result.structuredContent, calls: runner.calls, seatsReserved };
}

describe("B5 council modes", () => {
  it("maps each mode to the master plan's seat set", () => {
    expect(councilSeatsFor("quick", false)).toEqual(["critic"]);
    expect(councilSeatsFor("quick", true)).toEqual(["critic", "security"]);
    expect(councilSeatsFor("standard", false)).toEqual(STANDARD);
    expect(councilSeatsFor("standard", true)).toEqual(STANDARD);
    expect(councilSeatsFor("adversarial", false)).toEqual([...STANDARD, "devil"]);
    expect(councilSeatsFor("off", true)).toEqual([]);
  });

  it("quick runs only the Critic and keeps the single-seat response shape", async () => {
    const { body, calls, seatsReserved, result } = await council({ mode: "quick" });
    expect(calls.map((call) => call.seat)).toEqual(["critic"]);
    expect(result.isError).toBe(false);
    expect(body).toMatchObject({ status: "verdict", mode: "quick", seat: "critic", path: "B", result: "pass", seatsRun: 1 });
    expect(seatsReserved).toBe(1);
  });

  it("quick adds Security for a security-sensitive request (flag or card persona)", async () => {
    const flagged = await council({ mode: "quick", securitySensitive: true });
    expect(flagged.calls.map((call) => call.seat)).toEqual(["critic", "security"]);
    expect(flagged.seatsReserved).toBe(2);
    const ctx = await capsDeps({ now: () => NOW, runCouncilSeat: seatRunner().run });
    await ctx.store.saveRequest({
      id: "req-sec",
      ownerId: OWNER,
      goal: "Touch the login flow.",
      status: "running",
      card: { crew: "change", personas: ["builder", "security"], councilMode: "quick" },
      evidence: [],
      assignedBotId: BOT,
      repo: "owner/a",
      notices: [],
    });
    const runner = seatRunner();
    ctx.deps.runCouncilSeat = runner.run;
    await callConnectorTool(ctx.deps, auth, "request_council", { requestId: "req-sec", packet: "Diff: x" });
    expect(runner.calls.map((call) => call.seat)).toEqual(["critic", "security"]);
  });

  it("standard runs Architect, Strategist, Critic, Security, counts 4 seats, and merges the verdicts", async () => {
    const runner = seatRunner({
      strategist: { result: "discuss", actions: ["confirm the scope"] },
      security: { result: "changes", actions: ["escape the input"] },
    });
    const { body, calls, seatsReserved } = await council({ mode: "standard" }, runner);
    expect(calls.map((call) => call.seat)).toEqual(STANDARD);
    expect(calls.every((call) => call.packet.includes("Diff: x"))).toBe(true);
    expect(seatsReserved).toBe(4);
    expect(body).toMatchObject({ status: "verdict", mode: "standard", result: "changes", seatsRun: 4 });
    expect(body.actions).toEqual(["confirm the scope", "escape the input"]);
    expect((body.seats as { seat: string; status: string }[]).map((seat) => [seat.seat, seat.status])).toEqual(
      STANDARD.map((seat) => [seat, "verdict"]),
    );
    expect(body.seat).toBeUndefined();
  });

  it("standard with every seat passing merges to pass", async () => {
    const { body } = await council({ mode: "standard" });
    expect(body).toMatchObject({ status: "verdict", result: "pass" });
  });

  it("adversarial runs standard plus Devil; Devil has no backend, reports not-ready, and is not a pass", async () => {
    const { body, calls, seatsReserved, result } = await council({ mode: "adversarial" });
    expect(calls.map((call) => call.seat)).toEqual(STANDARD);
    expect(seatsReserved).toBe(4);
    expect(result.isError).toBe(true);
    expect(body.status).toBe("incomplete");
    expect(body.result).not.toBe("pass");
    expect(body.missingSeats).toEqual(["devil"]);
    const devil = (body.seats as Record<string, unknown>[]).find((seat) => seat.seat === "devil");
    expect(devil).toMatchObject({ status: "not-ready", reason: "devil_backend_unavailable" });
    expect(devil?.result).toBeUndefined();
  });

  it("an incomplete review keeps a changes verdict from the seats that ran", async () => {
    const { body } = await council({ mode: "adversarial" }, seatRunner({ critic: { result: "changes", actions: ["guard null"] } }));
    expect(body).toMatchObject({ status: "incomplete", result: "changes" });
    expect(body.actions).toEqual(["guard null"]);
  });

  it("a seat that fails on its own is reported and never counts as a pass", async () => {
    const { body, calls, seatsReserved } = await council({ mode: "standard" }, seatRunner({ architect: new Error("deadline") }));
    expect(calls.map((call) => call.seat)).toEqual(STANDARD);
    expect(seatsReserved).toBe(4);
    expect(body.status).toBe("incomplete");
    expect(body.result).not.toBe("pass");
    expect(body.missingSeats).toEqual(["architect"]);
    expect((body.seats as Record<string, unknown>[])[0]).toMatchObject({ seat: "architect", status: "error", reason: "deadline" });
  });

  it("a path-wide not-ready stops the review without a verdict", async () => {
    const { body, calls, result } = await council(
      { mode: "standard" },
      seatRunner({ architect: new CodexNotReadyError("download_failed") }),
    );
    expect(calls.map((call) => call.seat)).toEqual(["architect"]);
    expect(result.isError).toBe(true);
    expect(body).toMatchObject({ status: "not-ready", reason: "codex_not_ready: download_failed" });
    expect(body.result).toBeUndefined();
  });

  it("the weekly cap counts each seat; a review that hits it mid-way stops and is incomplete", async () => {
    const { body, calls, seatsReserved } = await council({ mode: "standard" }, seatRunner(), COUNCIL_WEEKLY_SEAT_CAP - 2);
    expect(calls.map((call) => call.seat)).toEqual(["architect", "strategist"]);
    expect(seatsReserved).toBe(2);
    expect(body).toMatchObject({ status: "incomplete", missingSeats: ["critic", "security"] });
    expect(body.result).not.toBe("pass");
    expect((body.seats as Record<string, unknown>[])[2]).toMatchObject({ seat: "critic", status: "refused", reason: "council_weekly_cap" });
    const full = await council({ mode: "standard" }, seatRunner(), COUNCIL_WEEKLY_SEAT_CAP);
    expect(full.calls).toHaveLength(0);
    expect(full.body).toMatchObject({ status: "refused", reason: "council_weekly_cap" });
  });

  it("takes the mode from the request's plan card when the call names none, and refuses unknown modes", async () => {
    const ctx = await capsDeps({ now: () => NOW });
    await ctx.store.saveRequest({
      id: "req-std",
      ownerId: OWNER,
      goal: "Ship it.",
      status: "running",
      card: { crew: "change", personas: ["builder"], councilMode: "standard" },
      evidence: [],
      assignedBotId: BOT,
      repo: "owner/a",
      notices: [],
    });
    const runner = seatRunner();
    ctx.deps.runCouncilSeat = runner.run;
    ctx.deps.councilConfigured = true;
    await callConnectorTool(ctx.deps, auth, "request_council", { requestId: "req-std", packet: "Diff: x" });
    expect(runner.calls.map((call) => call.seat)).toEqual(STANDARD);
    const bad = await council({ mode: "paranoid" });
    expect(bad.body).toMatchObject({ status: "refused", reason: "invalid_council_mode" });
    expect(bad.calls).toHaveLength(0);
  });
});

describe("B5 seat prompts", () => {
  it("every seat has a persona file, and its prompt carries that persona and the packet", () => {
    const personas = loadPersonas();
    expect([...COUNCIL_SEATS]).toEqual(["architect", "strategist", "critic", "security", "devil"]);
    for (const seat of COUNCIL_SEATS) {
      const persona = personas.get(seat);
      expect(persona, seat).toBeTruthy();
      const prompt = seatPrompt(seat, "Diff: y", personas);
      expect(prompt).toContain(persona!.split("\n").slice(-1)[0]);
      expect(prompt).toContain("Diff: y");
      expect(prompt.toLowerCase()).toContain(`${seat} seat`);
    }
  });
});
