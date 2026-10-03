import type { PlanCard, RoleSheet } from "../kernel/types.ts";

export type CeoDecision = {
  text: string;
  card: PlanCard;
  model: string;
  effort: string;
};

export type CeoClient = {
  calls: number;
  decide(text: string, onDelta?: (delta: string) => void): Promise<CeoDecision>;
};

function card(partial: Pick<PlanCard, "crew" | "personas" | "councilMode" | "tier" | "definitionOfDone" | "outOfScope">): PlanCard {
  return {
    ...partial,
    needsOwner: [],
    newScreen: false,
    outwardAction: false,
    requiresDesignApproval: false,
    requiresApproval: false,
  };
}

export function cardForAsk(text: string): PlanCard {
  const normalized = text.toLowerCase();
  if (/\blook into\b|\bresearch\b|\bwhat to do\b/.test(normalized)) {
    return card({
      crew: "research",
      personas: ["researcher"],
      councilMode: "quick",
      tier: "T2",
      definitionOfDone: "A sourced note with one next action.",
      outOfScope: "No repository change and nothing sent.",
    });
  }
  if (/\bfix\b|\bchange\b|\bin the repo\b|\bin repo\b/.test(normalized)) {
    return card({
      crew: "change",
      personas: ["builder", "qa"],
      councilMode: "quick",
      tier: "T2",
      definitionOfDone: "The check passes on the declared paths.",
      outOfScope: "No new screen and nothing sent.",
    });
  }
  if (/\bdifference\b|\bexplain\b/.test(normalized)) {
    return card({
      crew: "answer",
      personas: ["dexter"],
      councilMode: "off",
      tier: "T1",
      definitionOfDone: "The reply answers the question.",
      outOfScope: "No repository change.",
    });
  }
  return card({
    crew: "custom",
    personas: ["dexter"],
    councilMode: "off",
    tier: "T1",
    definitionOfDone: "A plan the owner can accept.",
    outOfScope: "No unapproved outward action.",
  });
}

export function createScriptedCeo(sheet: RoleSheet): CeoClient {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async decide(text: string): Promise<CeoDecision> {
      calls += 1;
      return {
        text: "Plan ready.",
        card: cardForAsk(text),
        model: sheet.ceo.family,
        effort: sheet.ceo.reasoningEffort,
      };
    },
  };
}

export function createRejectingCeo(model: string, effort: string, cardValue: PlanCard): CeoClient {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async decide(): Promise<CeoDecision> {
      calls += 1;
      return { text: "no", card: cardValue, model, effort };
    },
  };
}
