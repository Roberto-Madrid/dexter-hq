# Watchdog (Stage 3 unit 6)

Owner action: copy `ops/watchdog.workflow.yml` to `.github/workflows/watchdog.yml`, then set:

1. GitHub Actions secret `DEXTER_WATCHDOG_SECRET` (random; never reuse `DEXTER_TICK_SECRET`)
2. Vercel env `DEXTER_WATCHDOG_SECRET` (same value)
3. GitHub Actions variable `DEXTER_HQ_URL` (production HQ origin, no trailing slash)

The job GETs `/api/tick-now` with header `x-dexter-watchdog` and fails unless the body is `{ ok: true, ... }`.
