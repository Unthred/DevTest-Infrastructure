#!/usr/bin/env bash
# Reject AI attribution in commit messages and in the pull request body (homeowner rule: no AI attribution in any repository).
# Run from the repository root:
#   bash tools/ci/validate-commit-attribution.sh [base-ref] [head-ref]
# Defaults: merge-base(origin/main, HEAD)..HEAD. The pull request body is read from $PR_BODY when set.
# Matches whole lines only, case-insensitively: AI co-author trailers, "Generated with/by <AI tool>" footers, "Made with <AI tool>",
# AI-tool session links and the well-known AI bot e-mail addresses. Only the offending line is printed, never the whole message.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
BASE="${1:-}"
HEAD="${2:-HEAD}"
if [[ -z "${BASE}" ]]; then
  if git rev-parse --verify origin/main >/dev/null 2>&1; then BASE="$(git merge-base origin/main "${HEAD}")"
  else echo "FAIL: no base ref supplied and origin/main unavailable" >&2; exit 1; fi
fi

AI='claude|anthropic|codex|openai|cursor|chatgpt|copilot|gemini|\bAI\b'
PAT="^[[:space:]_*>]*co-authored-by:.*(${AI})|^[[:space:]_*>]*(made-with|generated-by):.*(${AI})|^[[:space:]_*>]*(🤖[[:space:]]*)?(generated|made|created|written)[[:space:]]+(with|by)[[:space:]].*(${AI})|claude\\.ai/code|claude\\.com/claude-code|noreply@anthropic\\.com|cursoragent@cursor\\.com"

failures=0
scan() { # label, text
  local hits
  hits="$(printf '%s\n' "$2" | grep -iE -- "${PAT}" || true)"
  if [[ -n "${hits}" ]]; then
    while IFS= read -r line; do echo "FAIL: AI attribution in $1: ${line:0:160}" >&2; done <<< "${hits}"
    failures=$((failures + 1))
  fi
}

while IFS= read -r sha; do
  [[ -z "${sha}" ]] && continue
  scan "commit ${sha:0:12} ($(git log -1 --format=%s "${sha}" | cut -c1-60))" "$(git log -1 --format=%B "${sha}")"
done < <(git rev-list "${BASE}..${HEAD}")

if [[ -n "${PR_BODY:-}" ]]; then scan "the pull request body" "${PR_BODY}"; fi

if [[ "${failures}" -gt 0 ]]; then
  echo "validate-commit-attribution: ${failures} message(s) with AI attribution (${BASE:0:12}..${HEAD}). Remove the line; do not add a replacement." >&2
  exit 1
fi
echo "OK: validate-commit-attribution (${BASE:0:12}..${HEAD})"
