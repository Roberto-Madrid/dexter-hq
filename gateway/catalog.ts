import { parse } from "yaml";
import type { VersionPin } from "../kernel/versions.ts";

export type CatalogMatch = { family: string; prefix: string; suffix: string };

export function readCatalogMatch(sheetText: string): CatalogMatch[] {
  const raw = parse(sheetText) as { catalog_match?: CatalogMatch[] };
  return (raw.catalog_match ?? []).map((row) => ({
    family: String(row.family),
    prefix: String(row.prefix ?? ""),
    suffix: String(row.suffix ?? ""),
  }));
}

function excluded(id: string): boolean {
  return /(^|[-.])(fast|max|preview)([-.]|$)/i.test(id);
}

export function pinsFromIds(ids: readonly string[], matches: readonly CatalogMatch[]): VersionPin[] {
  return matches.flatMap((match) => {
    const found = ids
      .filter((id) => id.startsWith(match.prefix) && id.endsWith(match.suffix) && !excluded(id))
      .sort();
    const chosen = found.at(-1);
    return chosen ? [{ family: match.family, version: chosen }] : [];
  });
}
