#!/usr/bin/env bash
set -eu
committed="supabase/functions/_shared/kernel.js"
fresh="$(mktemp)"
node scripts/bundle-kernel.mjs "$fresh"
if ! cmp -s "$fresh" "$committed"; then
  echo "kernel bundle is stale: $committed" >&2
  rm -f "$fresh"
  exit 1
fi
rm -f "$fresh"
echo "kernel bundle fresh"
