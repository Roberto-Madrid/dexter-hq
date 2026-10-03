#!/usr/bin/env bash
# Fail when kernel source names a model vendor or product.
set -eu
dir="${1:-kernel}"
pattern='openai|anthropic|claude|opus|grok|xai|cursor|codex|chatgpt|composer|github|vercel|supabase|gemini|opencode|cohere|mistral|deepseek'
if grep -R -I -i -E -w -n "$pattern" "$dir" \
  --include='*.ts' --include='*.js' --include='*.mjs' --include='*.json' \
  --include='*.md' --include='*.yaml' --include='*.yml' >/tmp/dexter-vendor-hits.txt; then
  echo "vendor or product name under $dir" >&2
  cut -d: -f1 /tmp/dexter-vendor-hits.txt | sort -u >&2
  rm -f /tmp/dexter-vendor-hits.txt
  exit 1
fi
rm -f /tmp/dexter-vendor-hits.txt
exit 0
