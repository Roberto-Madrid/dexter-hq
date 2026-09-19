# Mission brief: BARBER-RECOVERY

**Status: PREPARED — NOT ACTIVATED, NOT DISPATCHED.**

This brief exists so the mission can be dispatched later without rediscovery. Nothing here
has been assigned to any worker. Activation requires the explicit owner prompt in master
plan section 20. Do not activate it automatically, and do not let its business details
enter Dexter's permanent identity.

- **Mission ID:** BARBER-RECOVERY
- **Scope revision:** 1 (prepared)
- **Source:** `reference/Dexter_HQ_Plan_v2.1.md` section 16
- **Prepared:** 2026-09-19 by the `bootstrap/hq-files` worker
- **Gate:** bootstrap acceptance must pass first (`bootstrap/acceptance.md`)

## Target

- **Repository:** `Roberto-Madrid/dexter-barber` (canonical). The plan says
  `Roberto-Madrid/Dexter`; that is a historical alias — the repository was renamed and
  GitHub still redirects it.
- **Base SHA:** resolve afresh at activation. Do not reuse a SHA recorded here or in the
  plan; historical commits in the plan are observations, not a base.
- **Reported production:** `https://dexter-mu-mauve.vercel.app` — reported, not verified by
  HQ.
- **Reported Supabase project:** `uzmvhoejpqhgsffpqdnf`.
- **Historical branch:** `cursor/dexter-os-m001-d763`.
- **Product identity in the app:** Leo Hart. Preserve the current approved brand until the
  owner changes it; make branding configurable.

## Outcome

A working single-barber booking application, verified and reviewable, with the existing app
preserved throughout.

## Scope

- One barber; no staff picker.
- Services with price and duration, and valid appointment slots.
- Customer booking, plus secure appointment viewing, rescheduling, and cancellation.
- Barber schedule: manual appointments for customers, working hours, blocked time, service
  configuration.
- Simple announcements and promotions, with optional consent-based push.
- Real persistence and authorization, with realistic fictional data.

## Excluded

CRM, inventory, orders, studio showcase, product catalog, and any gym work. The original
broader mission was explicitly superseded — its features are **not** unfinished
obligations and must not be restored as such.

## Leads to verify at the current base

Previous audit findings are leads, not verified defects. Code reading is not runtime
verification. Do not repeat the whole audit without a reason.

1. Staff manual booking may assign `customer_id` from the staff `auth.uid()`. Inspect the
   intended ownership and reproduce.
2. Cancellation reportedly does not enqueue a notification. Confirm the agreed
   notification requirement before calling it a defect.
3. Multiple bookings reportedly coexist while the appointment page shows only the first.
   Inspect the intended customer behavior.
4. Mission records reportedly still describe the obsolete scope and no hosting.
5. Google OAuth, installed-iPhone behavior, and push delivery remain unverified.

## Recovery order

Verify current source and deployment → reconcile scope and state → reproduce core blockers
in isolated development → delegate bounded fixes → integrate → independent verification →
owner review. No production changes by default.

## Acceptance criteria

Verify, with observed evidence: successful booking; double-booking rejection;
staff-created customer appointment ownership; persistence; permissions; rescheduling
atomicity; cancellation; visible announcements; applicable consent rules; and multiple
appointments if the agreed behavior supports them.

Every check reports `passed`, `failed`, `blocked`, or `not_tested`. A responding URL is
not success.

## Deliverables

A runnable review package, a draft PR, the tested revision, screenshots, the actual checks
run, unresolved device limitations, and a clear demonstration script.

## Boundaries at activation

Authorized by default: development edits, isolated tests, feature-branch commits and
pushes, draft PR preparation.

Not authorized without explicit owner approval: merging to `main`, production deployment,
hosting changes, mutating the live database, purchases, or client outreach. Hosting is
`leaveUnchanged` — Vercel project `prj_yFeb9XnErOYVXO3SSu4IfYBTu7JZ`. Prior hosting was
reportedly authorized; preserve that historical fact if corroborated, do not invent
approval timestamps, and do not treat it as authorizing future releases. Do not take the
existing app offline.

Use one migration owner. Separate VMs and branches do not isolate the hosted Supabase
project; use isolated development data or serialize database changes.
