/** The pins most tests launch with: one current model id per role-sheet family. */
export const PINS = [
  { family: "grok", version: "grok-4.7" },
  { family: "composer", version: "composer-2.5" },
  { family: "claude-opus", version: "claude-opus-5-5" },
  { family: "gpt-sol", version: "gpt-5.6-sol" },
];

/** Baseline `model_resolutions` rows for one owner, as the daily check would have written them. */
export function pinRows(ownerId: string, pins = PINS, resolvedAt = "2026-01-01T00:00:00.000Z") {
  return pins.map((pin) => ({ ownerId, ...pin, held: false, reason: "baseline", resolvedAt }));
}

/** A `GET /v1/models` id list like Cursor's, with ids the pin rules must skip. */
export const CATALOG_IDS = [
  "default",
  "grok-4.7",
  "grok-4.6",
  "grok-4.9-fast",
  "grok-5-preview",
  "composer-2.5",
  "composer-3-max",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "gpt-5.6-sol",
  "gpt-5.5",
];
