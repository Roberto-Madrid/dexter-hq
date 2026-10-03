import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { redactSecrets, runCeo, type CeoCall } from "../../gateway/client.ts";

function fakeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => {
    stdout.end();
    child.emit("close", null, "SIGKILL");
    return true;
  };
  return child;
}

const call: CeoCall = {
  model: "gpt-6.1-sol",
  effort: "medium",
  prompt: "plan",
  outputPath: "/tmp/out.json",
  codexBin: "/usr/bin/codex",
  home: "/tmp",
  disableTools: true,
};

describe("runCeo stdio", () => {
  it("ignores stdin and resolves the agent message card", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const stages: string[] = [];
    const pending = runCeo(call, () => {}, {
      deadline: Date.now() + 5_000,
      onStage: (stage) => stages.push(stage),
    });
    const card = { crew: "answer", text: "ok" };
    child.stdout.write(`${JSON.stringify({ type: "thread.started" })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "turn.started", model: "gpt-6.1-sol", reasoning_effort: "medium" })}\n`);
    child.stdout.write(
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(card) } })}\n`,
    );
    child.stdout.end();
    child.emit("close", 0, null);
    await expect(pending).resolves.toEqual(card);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
    expect(stages).toEqual(["spawn", "thread", "turn", "card", "exit"]);
  });

  it("kills at the deadline and names the stage that stalled", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const pending = runCeo(call, () => {}, { deadline: Date.now() + 200 });
    child.stdout.write(`${JSON.stringify({ type: "thread.started" })}\n`);
    await expect(pending).rejects.toThrow(/deadline stage=thread duration_ms=\d+/);
    expect(String(spawnMock.mock.calls.at(-1))).toBeDefined();
  });

  it("fails spawn_error when the process cannot start", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const pending = runCeo(call, () => {}, { deadline: Date.now() + 5_000 });
    child.stdout.end();
    child.emit("error", new Error("spawn failed"));
    child.emit("close", null, null);
    await expect(pending).rejects.toThrow(/^spawn_error /);
  });

  it("keeps a redacted stderr tail when the turn fails", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const pending = runCeo(call, () => {}, { deadline: Date.now() + 5_000 });
    child.stderr.write("token eyJabc.def.ghi failed\n");
    child.stdout.write(`${JSON.stringify({ type: "turn.failed", error: { message: "invalid_json_schema" } })}\n`);
    child.stdout.end();
    child.emit("close", 1, null);
    await expect(pending).rejects.toThrow(/invalid_json_schema/);
    await expect(pending).rejects.toThrow(/\[REDACTED\]/);
    expect(redactSecrets("eyJabc.def.ghi")).toBe("[REDACTED]");
  });
});
