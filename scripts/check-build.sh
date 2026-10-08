#!/usr/bin/env bash
# Runs the production build (bundle + next build) the way Vercel does, with no live secrets in the environment.
# Previews are off (vercel.json), so this is the only build a PR gets before main deploys.
# dexter-shortcut: CI reaches this through check:bundle because the box token cannot push .github/workflows; upgrade path: add `npm run check:build` as its own step in ci.yml and drop it from check:bundle.
set -eu
echo "check:build: running next build"
env -u SUPABASE_DB_URL -u SUPABASE_URL -u SUPABASE_SERVICE_ROLE_KEY -u DATABASE_URL -u CURSOR_API_KEY -u GH_HQ_TOKEN -u DEXTER_AGE_PRIVATE_KEY \
  npm run build
echo "check:build: next build passed"
