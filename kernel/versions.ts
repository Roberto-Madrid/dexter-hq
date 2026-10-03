export type VersionPin = { family: string; version: string };

export type VersionHold = {
  family: string;
  current: string;
  incoming: string;
  action: "hold";
};

export function holdVersionChanges(
  current: readonly VersionPin[],
  incoming: readonly VersionPin[],
): VersionHold[] {
  const pins = new Map(current.map((row) => [row.family, row.version]));
  const held: VersionHold[] = [];
  for (const row of incoming) {
    const pinned = pins.get(row.family);
    if (!pinned || pinned === row.version) continue;
    held.push({ family: row.family, current: pinned, incoming: row.version, action: "hold" });
  }
  return held;
}
