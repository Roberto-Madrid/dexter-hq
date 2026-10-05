# STOP ALL cancel HTTP (empty body)

- **Owns**: `adapters/cursor-cloud.ts`, `hq/stop.ts`, `kernel/types.ts`, `kernel/contracts.ts`, `tests/unit/stop.test.ts`
- **Out of scope**: UI, auth/key rotation, merging to main
- **Base**: `2a62e0fd` (origin/main / PR 23)
- **Change**: Cancel POST omits `Content-Type` and has no body. Unconfirmed reports may include `httpStatus` and a short `errorCode`. Connector row still `cancelled` only after confirmed 2xx.
