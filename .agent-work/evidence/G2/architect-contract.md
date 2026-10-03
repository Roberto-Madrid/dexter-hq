# Architect review — G2 contract

Verdict: accepted for lanes.

`kernel/types.ts` and `kernel/schemas.ts` cover the A.7 records, both state enums, the `Runtime` interface, `PlanCard`, `Dossier`, `Post`, `Verdict`, and the role-sheet types. Schemas are zod and `satisfies` the hand-written types. The kernel imports no vendor SDK and uses Web Crypto plus `fetch`-compatible globals only. Families and pool order stay data in `gateway/role-sheet.yaml`, which gained `pool_order` so the resolver does not hard-code product names.

The spike migration keeps its SQL and moves to `0006_spike_tick.sql` so `0001_core.sql` can exist beside it. That is a version-prefix change, not a behavior change.
