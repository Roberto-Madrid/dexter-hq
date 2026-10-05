import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXAMPLE_LABEL, exampleBots, exampleCounts } from "../../app/(hq)/example-fixture.ts";
import { resumeClearsStop } from "../../app/(hq)/control-result.ts";
import {
  assembleTower,
  exampleLabels,
  exampleTowerSnapshot,
  usesExampleFixtures,
} from "../../app/(hq)/tower-model.ts";
import { createMemoryConnectorStore } from "../../hq/connector-store.ts";
import { loadTowerSnapshot } from "../../hq/tower-load.ts";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

describe("control tower snapshot", () => {
  it("keeps Example fixtures labeled Example when no live source is configured", async () => {
    const snapshot = await loadTowerSnapshot({ env: {}, nowMs: NOW });
    expect(snapshot).toEqual(exampleTowerSnapshot());
    expect(usesExampleFixtures(snapshot)).toBe(true);
    expect(exampleLabels(snapshot)).toEqual([EXAMPLE_LABEL]);
    expect(snapshot.bots.source).toBe("example");
    expect(snapshot.needs.source).toBe("example");
    expect(snapshot.ceo.source).toBe("example");
    expect(snapshot.swarm.source).toBe("example");
    expect(snapshot.requests.source).toBe("example");
    expect(snapshot.counts.every((item) => item.source === "example")).toBe(true);
    expect(snapshot.counts.map((item) => item.value)).toEqual(exampleCounts.map((item) => item.value));
    expect(snapshot.bots.items.map((bot) => bot.name)).toEqual(exampleBots.map((bot) => bot.name));
    expect(snapshot.swarm.desktop.labels.some((label) => label.lines.includes("Dexter"))).toBe(true);
  });

  it("does not treat empty env cursor keys as live usage or invented agents", async () => {
    const snapshot = await loadTowerSnapshot({
      env: { SUPABASE_DB_URL: "", CURSOR_API_KEY: "" },
      nowMs: NOW,
    });
    expect(snapshot.counts.find((item) => item.label === "Cursor")).toEqual({
      label: "Cursor",
      value: "18%",
      source: "example",
    });
    expect(snapshot.counts.find((item) => item.label === "Agents")?.source).toBe("example");
  });

  it("shows connector bots and pending approvals when they exist, without inventing the Example roster", () => {
    const snapshot = assembleTower({
      nowMs: NOW,
      connector: {
        bots: [
          {
            id: "bot-lead",
            ownerId: "owner",
            name: "HQ Dev",
            kind: "lead",
            repos: ["Roberto-Madrid/dexter-hq"],
            tools: ["whoami"],
            currentTask: "connector",
            heartbeatAt: new Date(NOW - 30_000).toISOString(),
          },
        ],
        requests: [
          {
            id: "req-1",
            ownerId: "owner",
            goal: "Wire the Bots panel",
            status: "running",
            card: null,
            evidence: [],
            assignedBotId: "bot-lead",
            repo: "Roberto-Madrid/dexter-hq",
            notices: [],
          },
        ],
        approvals: [
          {
            id: "appr-1",
            ownerId: "owner",
            action: "deploy",
            target: "preview",
            status: "pending",
            requestId: "req-1",
          },
        ],
        events: [
          {
            id: "evt-1",
            ownerId: "owner",
            actor: "HQ Dev",
            action: "open_request",
            target: "req-1",
            result: { status: "opened" },
            at: new Date(NOW).toISOString(),
          },
        ],
        agents: [
          {
            id: "agent-1",
            ownerId: "owner",
            botId: "bot-lead",
            cursorHandle: "bc-live:run-1",
            repo: "Roberto-Madrid/dexter-hq",
            role: "builder",
            family: "grok",
            status: "running",
            idempotencyKey: "k1",
            result: null,
          },
        ],
      },
    });
    expect(snapshot.bots.source).toBe("live");
    expect(snapshot.bots.items.map((bot) => bot.name)).toEqual(["HQ Dev"]);
    expect(snapshot.bots.items.map((bot) => bot.name)).not.toContain("dreggbot");
    expect(snapshot.needs.source).toBe("live");
    expect(snapshot.needs.items[0]?.text).toContain("deploy");
    expect(snapshot.ceo.source).toBe("live");
    expect(snapshot.requests.source).toBe("live");
    expect(snapshot.swarm.source).toBe("live");
    expect(snapshot.counts.find((item) => item.label === "Agents")).toEqual({
      label: "Agents",
      value: "1/3",
      source: "live",
    });
    expect(snapshot.counts.find((item) => item.label === "Cursor")?.source).toBe("example");
    expect(snapshot.counts.find((item) => item.label === "Cursor")?.value).toBe("18%");
    expect(usesExampleFixtures(snapshot)).toBe(true);
    expect(exampleLabels(snapshot)).toEqual([EXAMPLE_LABEL]);
  });

  it("reads a memory connector through loadTowerSnapshot without calling a database", async () => {
    const store = createMemoryConnectorStore({
      bots: [
        {
          id: "bot-ceo",
          ownerId: "owner",
          name: "unit-ceo",
          kind: "ceo",
          repos: [],
          tools: ["whoami"],
          currentTask: null,
          heartbeatAt: new Date(NOW - 10_000).toISOString(),
        },
      ],
    });
    const snapshot = await loadTowerSnapshot({
      env: { SUPABASE_DB_URL: "postgresql://unused" },
      nowMs: NOW,
      readConnector: async () => ({
        bots: await store.listBots(),
        requests: await store.listRequests(),
        approvals: await store.listApprovals(),
        events: await store.listEvents(),
        agents: await store.listAgents(),
      }),
    });
    expect(snapshot.bots.source).toBe("live");
    expect(snapshot.bots.items[0]?.name).toBe("unit-ceo");
    expect(snapshot.bots.items[0]?.state).toBe("live");
    expect(snapshot.needs.source).toBe("example");
    expect(snapshot.needs.items.some((item) => item.text.includes("Vercel production"))).toBe(true);
  });

  it("fails if the tower can stop and then has no Resume path to /api/resume", () => {
    const source = readFileSync("app/(hq)/command-center.tsx", "utf8");
    expect(source).toContain("STOP ALL");
    expect(source).toContain('"/api/stop"');
    expect(source).toContain("Resume");
    expect(source).toContain('"/api/resume"');
    expect(source).toMatch(/stopped\s*\?\s*\([\s\S]*Resume/);
    expect(source).not.toMatch(/fetch\(\s*["']https?:\/\//);
  });

  it("does not treat HTTP 200 with resumed false as a successful resume", () => {
    expect(resumeClearsStop(200, { resumed: false, asOf: "2026-10-04T12:00:00.000Z" })).toBe(false);
    expect(resumeClearsStop(200, { resumed: true })).toBe(true);
    expect(resumeClearsStop(401, { resumed: true })).toBe(false);
    const source = readFileSync("app/(hq)/command-center.tsx", "utf8");
    expect(source).toContain("resumeClearsStop");
    expect(source).not.toMatch(/\/api\/resume[\s\S]{0,80}return response\.ok/);
  });

  it("carries the connector stop flag so Resume can render after a reload", () => {
    const stopped = assembleTower({
      nowMs: NOW,
      connector: {
        stopped: true,
        bots: [
          {
            id: "bot-lead",
            ownerId: "owner",
            name: "HQ Dev",
            kind: "lead",
            repos: ["Roberto-Madrid/dexter-hq"],
            tools: ["whoami"],
            currentTask: null,
            heartbeatAt: new Date(NOW - 10_000).toISOString(),
          },
        ],
      },
    });
    expect(stopped.stopped).toBe(true);
    expect(exampleTowerSnapshot().stopped).toBe(false);
  });
});
