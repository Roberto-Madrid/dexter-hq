import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXAMPLE_LABEL, exampleBots, exampleCounts } from "../../app/(hq)/example-fixture.ts";
import { resumeClearsStop } from "../../app/(hq)/control-result.ts";
import {
  assembleTower,
  edgeCrossesLabel,
  exampleLabels,
  exampleTowerSnapshot,
  graphFromSwarm,
  PHONE_SWARM_CHROME,
  PHONE_SWARM_VIEWPORT,
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
      value: "1",
      detail: "of 3",
      source: "live",
    });
    expect(snapshot.counts.find((item) => item.label === "Cursor")).toEqual({
      label: "Cursor",
      value: "unknown",
      source: "live",
    });
    expect(snapshot.swarm.nodes.find((node) => node.parentId === null)?.label).toBe("Dexter");
    expect(snapshot.swarm.nodes.some((node) => node.label === "HQ Dev" && node.parentId !== null)).toBe(true);
    expect(usesExampleFixtures(snapshot)).toBe(false);
    expect(exampleLabels(snapshot)).toEqual([]);
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
    expect(snapshot.swarm.nodes.find((node) => node.parentId === null)).toMatchObject({
      id: "bot-ceo",
      label: "Dexter",
    });
    expect(snapshot.counts.find((item) => item.label === "Cursor")).toEqual({
      label: "Cursor",
      value: "unknown",
      source: "live",
    });
    expect(snapshot.counts.find((item) => item.label === "Agents")).toEqual({
      label: "Agents",
      value: "0",
      detail: "of 3",
      source: "live",
    });
  });

  it("grows the live graph from Dexter when the only bot is a lead", () => {
    const snapshot = assembleTower({
      nowMs: NOW,
      connector: {
        bots: [
          {
            id: "bot-proof",
            ownerId: "owner",
            name: "stage1-proof",
            kind: "lead",
            repos: ["Roberto-Madrid/dexter-hq"],
            tools: ["whoami"],
            currentTask: "proof",
            heartbeatAt: new Date(NOW - 20_000).toISOString(),
          },
        ],
        agents: [],
      },
      cursor: {
        usageText: null,
        runs: [
          { id: "run-live", name: "Stage 1 dashboard panels", status: "RUNNING" },
          { id: "run-old", name: "chore: bump familia base", status: "FINISHED" },
          { id: "run-form", name: "English carpool skill (cost)", status: "CREATING" },
        ],
      },
    });
    const hub = snapshot.swarm.nodes.find((node) => node.parentId === null);
    expect(hub?.label).toBe("Dexter");
    expect(hub?.id).not.toBe("bot-proof");
    expect(snapshot.swarm.nodes.find((node) => node.label === "stage1-proof")?.parentId).toBe(hub?.id);
    expect(snapshot.swarm.desktop.nodes[0]).toMatchObject({ cx: 430, cy: 430 });
    expect(snapshot.swarm.desktop.labels[0]?.lines).toEqual(["Dexter"]);
    expect(snapshot.swarm.desktop.status.startsWith("Growing from Dexter")).toBe(true);
    expect(snapshot.counts.find((item) => item.label === "Agents")).toEqual({
      label: "Agents",
      value: "2",
      detail: "of 3",
      source: "live",
    });
    expect(snapshot.counts.find((item) => item.label === "Cursor")?.value).toBe("unknown");
    expect(snapshot.counts.find((item) => item.label === "Cursor")?.value).not.toBe("18%");
  });

  it("does not invent Cursor usage when live rows exist without a usage reading", () => {
    const snapshot = assembleTower({
      nowMs: NOW,
      connector: { bots: [], requests: [], approvals: [], events: [], agents: [] },
      cursor: { runs: [], usageText: null },
    });
    expect(snapshot.counts.find((item) => item.label === "Cursor")).toEqual({
      label: "Cursor",
      value: "unknown",
      source: "live",
    });
    expect(snapshot.needs.source).toBe("example");
  });

  it("places lower-half labels away from each other instead of stacking to the right", () => {
    const nodes = [
      { id: "dexter", label: "Dexter", parentId: null, tone: "live" as const },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `n-${index}`,
        label: `Node title ${index} long enough to collide`,
        parentId: "dexter",
        tone: "live" as const,
        ring: 2 as const,
      })),
    ];
    const graph = graphFromSwarm(nodes, { width: 860, height: 860 }, "Growing from Dexter");
    const dexter = graph.nodes[0];
    expect(dexter).toMatchObject({ cx: 430, cy: 430 });
    expect(graph.labels.some((label) => label.align === "right")).toBe(true);
    expect(graph.labels.some((label) => label.align === "center")).toBe(true);
    const lower = graph.labels.filter((_, index) => index > 0 && graph.nodes[index].cy > 430);
    expect(lower.length).toBeGreaterThan(4);
    const boxes = lower.map((label) => ({
      left: label.left,
      top: label.top,
      width: label.width,
      height: label.lines.length * 13,
    }));
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const hit = !(
          a.left + a.width <= b.left ||
          b.left + b.width <= a.left ||
          a.top + a.height <= b.top ||
          b.top + b.height <= a.top
        );
        if (hit) overlaps += 1;
      }
    }
    expect(overlaps).toBe(0);
    const uniqueLeft = new Set(lower.map((label) => Math.round(label.left)));
    expect(uniqueLeft.size).toBeGreaterThan(2);
  });

  it("at 390×844 keeps Dexter centered and never lets an edge cross a label", () => {
    const titles = [
      "Tower graph matches the approved layout",
      "Stage 1 Council endpoint",
      "Resume after STOP ALL",
      "Needs-you approval executor",
      "Stage 1 STOP ALL",
      "Stage 1 dashboard panels",
      "Token police development",
      "chore: denser home + familia 20px base font",
      "English carpool skill (cost)",
      "English AGENTS.md + carpool.mdc",
      "chore: familia 20px, denser home, fix hydration",
      "Dexter initial product",
      "chore: ws transport for Supabase admin on Node 20",
      "Fix familia anuncios open animation + mid-flow restore",
      "Stage 0 MCP stub",
      "Stage 1 connector tools",
      "Add pickup_state revoke migration",
      "chore: bump /familia base font to 17px",
      "One Council seat B through path",
      "Light control tower",
      "stage1-proof",
    ];
    const nodes = [
      { id: "dexter", label: "Dexter", parentId: null, tone: "live" as const },
      ...titles.map((label, index) => ({
        id: `n-${index}`,
        label,
        parentId: "dexter",
        tone: "forming" as const,
        ring: (index === titles.length - 1 ? 1 : 2) as 1 | 2,
      })),
    ];
    const sizes = [PHONE_SWARM_VIEWPORT, { width: 390, height: PHONE_SWARM_VIEWPORT.height - PHONE_SWARM_CHROME }];
    for (const size of sizes) {
      const graph = graphFromSwarm(nodes, size, "Growing from Dexter · 0 of 21 links live");
      expect(graph.nodes).toHaveLength(22);
      expect(graph.nodes[0]).toMatchObject({ cx: size.width / 2, cy: size.height / 2 });
      expect(graph.labels[0]?.lines).toEqual(["Dexter"]);
      const boxes = graph.labels
        .filter((label) => label.lines.length > 0)
        .map((label) => ({
          left: label.left,
          top: label.top,
          width: label.width,
          height: label.lines.length * 13,
        }));
      for (const line of graph.lines) {
        for (const box of boxes) {
          expect(edgeCrossesLabel(line, box)).toBe(false);
        }
      }
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i];
          const b = boxes[j];
          const hit = !(
            a.left + a.width + 3 <= b.left ||
            b.left + b.width + 3 <= a.left ||
            a.top + a.height + 3 <= b.top ||
            b.top + b.height + 3 <= a.top
          );
          expect(hit).toBe(false);
        }
      }
      expect(graph.labels.filter((label) => label.lines.length === 1).length).toBeGreaterThan(0);
      expect(graph.labels.every((label) => label.lines.length <= 1)).toBe(true);
      expect(graph.nodes.length - 1).toBe(21);
    }
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
