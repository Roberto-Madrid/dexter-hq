import { describe, expect, it } from "vitest";
import { decideApproval } from "../../hq/approval.ts";
import { AGENT_SURGE_CAP } from "../../hq/connector.ts";
import { SURGE_TTL_MS, surgeExpiresAt } from "../../hq/surge.ts";
import { OWNER, capsDeps, launch } from "./caps-fixtures.ts";

const T0 = "2026-10-08T12:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

async function setup(decision: "approved" | "denied" | null, action = "surge") {
  let now = T0;
  const ctx = await capsDeps({ now: () => now });
  await ctx.store.saveApproval({ id: "ap-1", ownerId: OWNER, action, target: "agents", status: "pending", requestId: null });
  const decided = decision ? await decideApproval(ctx.store, { approvalId: "ap-1", decision, now: () => T0 }) : null;
  return {
    ...ctx,
    decided,
    setNow(value: string) {
      now = value;
    },
  };
}

const withSurge = { approvalId: "ap-1" };
const SIX = ["owner/a", "owner/a", "owner/b", "owner/b", "owner/c", "owner/c"];

describe("B4 surge TTL", () => {
  it("uses a 24h TTL and stamps the expiry on the approval decision", async () => {
    expect(SURGE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    const { store, decided } = await setup("approved");
    const approval = await store.getApproval("ap-1");
    expect(approval?.decidedAt).toBe(T0);
    expect(surgeExpiresAt(approval!)).toBe(at(SURGE_TTL_MS));
    expect(decided).toMatchObject({ status: "approved", expiresAt: at(SURGE_TTL_MS) });
    const events = await store.listEvents();
    expect(events.some((event) => event.action === "approval" && event.result?.expiresAt === at(SURGE_TTL_MS))).toBe(true);
  });

  it("within the TTL an approved surge raises the global cap to 6", async () => {
    const { deps, setNow } = await setup("approved");
    setNow(at(SURGE_TTL_MS - 1000));
    for (const [index, repo] of SIX.entries()) {
      expect((await launch(deps, `s${index}`, repo, undefined, withSurge)).structuredContent.status, `launch ${index}`).toBe("launched");
    }
    const seventh = await launch(deps, "s7", "owner/d", undefined, withSurge);
    expect(seventh.structuredContent).toMatchObject({ status: "refused", reason: "surge_cap", cap: AGENT_SURGE_CAP });
  });

  it("after the TTL launches use cap 3 again, and the lapse is recorded once", async () => {
    const { deps, store, setNow } = await setup("approved");
    setNow(at(SURGE_TTL_MS + 1000));
    for (const [index, repo] of ["owner/a", "owner/b", "owner/c"].entries()) {
      expect((await launch(deps, `e${index}`, repo, undefined, withSurge)).structuredContent.status).toBe("launched");
    }
    const fourth = await launch(deps, "e4", "owner/d", undefined, withSurge);
    expect(fourth.structuredContent).toMatchObject({ status: "refused", reason: "agent_cap", cap: 3, surgeExpired: true });
    await launch(deps, "e5", "owner/d", undefined, withSurge);
    const lapses = await store.listEventsByAction(["surge_lapsed"]);
    expect(lapses).toHaveLength(1);
    expect(lapses[0]).toMatchObject({ target: "ap-1", result: { expiresAt: at(SURGE_TTL_MS), cap: 3 } });
  });

  it("reverts on its own: agents launched under a surge block new launches once it lapses", async () => {
    const { deps, setNow } = await setup("approved");
    for (const [index, repo] of SIX.entries()) {
      expect((await launch(deps, `r${index}`, repo, undefined, withSurge)).structuredContent.status).toBe("launched");
    }
    setNow(at(SURGE_TTL_MS));
    const after = await launch(deps, "r7", "owner/d", undefined, withSurge);
    expect(after.structuredContent).toMatchObject({ status: "refused", reason: "agent_cap", cap: 3 });
  });

  it("ignores a pending, denied, or non-surge approval", async () => {
    for (const [decision, action] of [
      [null, "surge"],
      ["denied", "surge"],
      ["approved", "deploy"],
    ] as const) {
      const { deps } = await setup(decision, action);
      for (const [index, repo] of ["owner/a", "owner/b", "owner/c"].entries()) {
        expect((await launch(deps, `i${index}`, repo, undefined, withSurge)).structuredContent.status).toBe("launched");
      }
      const fourth = await launch(deps, "i4", "owner/d", undefined, withSurge);
      expect(fourth.structuredContent, `${decision} ${action}`).toMatchObject({ status: "refused", reason: "agent_cap", cap: 3 });
    }
  });

  it("fails closed on an approved surge with no decision time", async () => {
    const { deps, store } = await setup(null);
    await store.saveApproval({ id: "ap-1", ownerId: OWNER, action: "surge", target: "agents", status: "approved", requestId: null });
    for (const [index, repo] of ["owner/a", "owner/b", "owner/c"].entries()) {
      await launch(deps, `l${index}`, repo, undefined, withSurge);
    }
    expect((await launch(deps, "l4", "owner/d", undefined, withSurge)).structuredContent).toMatchObject({ reason: "agent_cap", cap: 3 });
  });
});
