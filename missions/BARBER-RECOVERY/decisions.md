# Decisions: BARBER-RECOVERY

Scope changes and approval provenance for this mission. Append entries; do not rewrite
history. Record a decision **before** dispatching the tasks it affects.

An entry needs: date, the decision, who authorized it, where that instruction came from,
the resulting scope revision, and which tasks it affects.

---

## 2026-09-19 — Mission prepared, not activated

- **Decision:** Prepare BARBER-RECOVERY as a dispatchable mission record without
  activating or dispatching it.
- **Authorized by:** owner, via the bootstrap worker assignment ("PREPARED status only —
  this mission is NOT activated; record it as prepared-not-dispatched").
- **Provenance:** master plan section 16, which labels this a prepared mission activated by
  the separate prompt in section 20.
- **Scope revision:** 1 (prepared).
- **Affects:** no tasks. Nothing has been dispatched.

## 2026-09-19 — Canonical repository name corrected

- **Decision:** The target repository is `Roberto-Madrid/dexter-barber`. Record
  `Roberto-Madrid/Dexter` as a historical alias only.
- **Authorized by:** owner, explicit correction.
- **Provenance:** The repository was renamed; GitHub still redirects the old name. The
  master plan (sections 4 and 16) predates the rename. Corroborated by the pre-existing
  `dexter-barber/.cursor/dispatch.json`, which records
  `https://github.com/Roberto-Madrid/dexter-barber`.
- **Affects:** all future assignments for this mission must target `dexter-barber`.

## 2026-09-19 — Superseded broader scope stays superseded

- **Decision:** The original broader barber mission remains explicitly superseded. Its
  features are not unfinished obligations and must not be restored.
- **Authorized by:** owner, recorded in master plan section 16.
- **Provenance:** "The original broader mission was explicitly superseded. Do not restore
  its features as unfinished obligations."
- **Affects:** scope of every task under this mission.

## 2026-09-19 — Base SHA deliberately left unset

- **Decision:** `target.base_sha` is `null`. The intended base is resolved afresh at
  activation.
- **Authorized by:** HQ judgment under master plan section 7.
- **Provenance:** The plan records historical commits as observations and requires
  resolving the intended base for each new task. Recording a SHA now would create the
  stale-checkout failure the plan exists to prevent.
- **Affects:** the project-lead assignment at activation.

## 2026-09-19 — Activation blocked by dispatch capability

- **Decision:** Record this mission as `blocked` for dispatch rather than pending.
- **Authorized by:** HQ, reporting an observed limitation.
- **Provenance:** `DEXTER_CURSOR_API_KEY` is configured by the owner but is not injected
  into agent runs; verified absent in run `bc-7c2ba0a5-660e-56c3-a728-5af2a12816c8` on
  2026-09-19 without reading its value. Bootstrap acceptance has not passed.
- **Affects:** activation itself. HQ will not substitute its own implementation.
