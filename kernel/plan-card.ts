import type { PlanCard } from "./types.ts";

export const CREW_ORDER = [
  "answer",
  "research",
  "change",
  "custom",
  "build",
  "make",
  "automate",
  "job-scan",
  "venture-check",
  "web3",
  "handoff",
] as const;

export type ValidatedPlan = { card: PlanCard; notices: string[] };

export function nearestCrew(requested: string, shipped: readonly string[]): string {
  if (shipped.includes(requested)) return requested;
  const index = new Map<string, number>(CREW_ORDER.map((crew, i) => [crew, i]));
  const target = index.get(requested) ?? 0;
  const ranked = [...shipped].sort((a, b) => {
    const da = index.has(a) ? Math.abs((index.get(a) as number) - target) : 1000;
    const db = index.has(b) ? Math.abs((index.get(b) as number) - target) : 1000;
    if (da !== db) return da - db;
    return (index.get(a) ?? 1000) - (index.get(b) ?? 1000);
  });
  return ranked[0] ?? requested;
}

function withNeed(needs: string[], item: string): string[] {
  return needs.includes(item) ? needs : [...needs, item];
}

export function validatePlanCard(input: PlanCard, shipped: readonly string[]): ValidatedPlan {
  const card: PlanCard = {
    ...input,
    personas: [...input.personas],
    needsOwner: [...input.needsOwner],
  };
  const notices: string[] = [];

  if (card.newScreen) {
    card.requiresDesignApproval = true;
    card.needsOwner = withNeed(card.needsOwner, "design");
  }
  if (card.outwardAction) {
    card.requiresApproval = true;
    card.needsOwner = withNeed(card.needsOwner, "approval");
  }
  if (card.tier === "T3" && card.councilMode !== "adversarial") {
    card.councilMode = "adversarial";
    notices.push("t3_requires_adversarial_council");
  }
  if (!shipped.includes(card.crew)) {
    const nearest = nearestCrew(card.crew, shipped);
    notices.push(`unshipped_crew:${card.crew}->${nearest}`);
    card.crew = nearest;
  }
  return { card, notices };
}
