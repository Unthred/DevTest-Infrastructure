#!/usr/bin/env bash
# D-023: feature branches never edit docs/ai/CURRENT_HANDOVER.md; it changes only on main (post-merge step or a handover docs PR).
# Run from the repository root:
#   bash tools/ci/validate-no-handover-edit.sh [base-ref] [head-ref]
# Defaults: merge-base(origin/main, HEAD)..HEAD. Fails when any commit in the range touches the handover (rename or delete included).
# Exempt: a head branch named docs/handover-* (the periodic handover docs PR), taken from $HEAD_REF.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
FILE='docs/ai/CURRENT_HANDOVER.md'
BASE="${1:-}"
HEAD="${2:-HEAD}"
if [[ -z "${BASE}" ]]; then
  if git rev-parse --verify origin/main >/dev/null 2>&1; then BASE="$(git merge-base origin/main "${HEAD}")"
  else echo "FAIL: no base ref supplied and origin/main unavailable" >&2; exit 1; fi
fi
for ref in "${BASE}" "${HEAD}"; do
  git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null || { echo "FAIL: ref '${ref:0:80}' is not a commit; the range was not checked" >&2; exit 1; }
done

if [[ "${HEAD_REF:-}" == docs/handover-* ]]; then echo "OK: validate-no-handover-edit (handover docs branch ${HEAD_REF:0:60} is exempt)"; exit 0; fi

# Three-dot: only what the branch itself changed, not what main gained since the branch point.
CHANGED="$(git diff --name-only --no-renames "${BASE}...${HEAD}" -- "${FILE}")" || { echo "FAIL: git diff failed; the range was not checked" >&2; exit 1; }
if [[ -n "${CHANGED}" ]]; then
  echo "FAIL: this branch edits ${FILE}. Feature branches must not (D-023): the dispatcher state and dashboard are the live record, and the handover is updated on main only. Revert it: git checkout ${BASE:0:12} -- ${FILE}" >&2
  exit 1
fi
echo "OK: validate-no-handover-edit (${BASE:0:12}..${HEAD})"
