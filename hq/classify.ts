export type QuestionKind = "status" | "cost" | "list" | "board" | "work";

const STATUS =
  /^(status\b|what(?:'s| is) (?:the )?(?:status|running|active|going on)|how many (?:runs|slots|tasks)|run slots|what is running)/i;
const COST =
  /^(cost\b|spend\b|usage\b|how much|what(?:'s| is) (?:the )?(?:cost|spend|usage)|what have we spent)/i;
const BOARD =
  /^(?:(?:show|list)\s+(?:me\s+)?(?:the\s+)?)?(?:board|findings|dead[ -]?ends?|shortcuts|handoffs)\b|^what(?:'s| is) on the board/i;
const LIST = /^(list\b|show\b|what(?:'s| are) (?:the )?(?:requests|missions|cards))/i;

export function classifyQuestion(text: string): QuestionKind {
  const trimmed = text.trim();
  if (STATUS.test(trimmed)) return "status";
  if (COST.test(trimmed)) return "cost";
  if (BOARD.test(trimmed)) return "board";
  if (LIST.test(trimmed)) return "list";
  return "work";
}
