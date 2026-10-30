#!/usr/bin/env bash
# Run the supervisor preflight exactly as cron would: empty environment plus the PATH/HOME pinned in the generated
# reconcile script. Exit 0 only if gh, git, claude and codex all resolve and are usable there (issue #35).
set -euo pipefail
script=${1:?usage: verify-reconcile-env.sh GENERATED_SCRIPT}
[ -r "$script" ] || { printf 'script not readable\n' >&2; exit 2; }
# shellcheck disable=SC1090
eval "$(sed -n '/^# BEGIN-ENV$/,/^# END-ENV$/p' "$script")"
[ -x "$NODE" ] && [ -r "$CLI" ] || { printf 'node or supervisor cli missing in pinned environment\n' >&2; exit 2; }
exec env -i PATH="$PATH" HOME="$HOME" "$NODE" "$CLI" preflight
