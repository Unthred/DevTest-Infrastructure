#!/usr/bin/env bash
set -euo pipefail
# --supervisor NEW PREVIOUS: undo tools/upgrade-supervisor.sh (restore the wrapper saved before NEW and point `current` back at PREVIOUS).
# Used by the automatic self-upgrade (issue #47). Jobs, leases, team.local.json and the launcher are not touched.
if [ "${1:-}" = "--supervisor" ]; then
  new=${2:?usage: rollback-supervisor.sh --supervisor NEW PREVIOUS}; previous=${3:?usage: rollback-supervisor.sh --supervisor NEW PREVIOUS}
  [[ "$new" =~ ^[a-f0-9]{40}$ && "$previous" =~ ^[a-f0-9]{40}$ ]] || exit 2
  bin=${AI_SUPERVISOR_BIN_DIR:-/root/bin}; state=${AI_SUPERVISOR_STATE_DIR:-/mnt/cache/ai-supervisor}
  backup="$bin/ai-supervisor.before-$new"
  [ -f "$backup" ] || { printf 'wrapper backup missing\n' >&2; exit 2; }
  [ -d "$state/versions/$previous" ] || { printf 'previous version missing\n' >&2; exit 2; }
  [ -L "$state/current" ] || { printf 'current supervisor path is not a symlink\n' >&2; exit 2; }
  bash -n "$backup"
  ln -s "versions/$previous" "$state/.current-rollback-$previous"
  mv -Tf "$state/.current-rollback-$previous" "$state/current"
  cp -p "$backup" "$bin/.ai-supervisor-rollback-$new"
  mv "$bin/.ai-supervisor-rollback-$new" "$bin/ai-supervisor"
  printf 'supervisor restored to %s from %s\n' "$previous" "$backup"
  exit 0
fi
commit=${1:?usage: rollback-supervisor.sh COMMIT}
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 2
backup="/root/bin/ai-agent.before-supervisor-$commit"
[ -f "$backup" ] || { printf 'backup missing\n' >&2; exit 2; }
cp -p "$backup" /root/bin/ai-agent
bash -n /root/bin/ai-agent
printf 'launcher restored from %s; preserve supervisor state and review jobs before removing wrapper\n' "$backup"
