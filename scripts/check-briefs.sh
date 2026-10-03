#!/usr/bin/env bash
# Fail when personas, crews, or worker brief templates name a model.
set -eu
root="${1:-.}"
pattern='openai|anthropic|claude|opus|grok|xai|cursor|codex|chatgpt|composer|github|vercel|gemini|opencode|gpt'
hits=0
scan() {
  local path="$1"
  if [ ! -e "$path" ]; then
    return 0
  fi
  if grep -R -I -i -E -w -n "$pattern" "$path" >/tmp/dexter-brief-hits.txt; then
    echo "model name under $path" >&2
    cut -d: -f1 /tmp/dexter-brief-hits.txt | sort -u >&2
    hits=1
  fi
  rm -f /tmp/dexter-brief-hits.txt
}
scan "$root/personas"
scan "$root/crews"
if [ -d "$root/workers" ]; then
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    if grep -I -i -E -w -n "$pattern" "$file" >/tmp/dexter-brief-hits.txt; then
      echo "model name in brief template $file" >&2
      hits=1
    fi
    rm -f /tmp/dexter-brief-hits.txt
  done < <(find "$root/workers" -type f \( -name '*brief*' -o -name '*briefs*' \) -print)
fi
exit "$hits"
