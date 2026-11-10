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
  was_current=$(readlink "$state/current" || true)
  ln -s "versions/$previous" "$state/.current-rollback-$previous"
  mv -Tf "$state/.current-rollback-$previous" "$state/current"
  cp -p "$backup" "$bin/.ai-supervisor-rollback-$new"
  mv "$bin/.ai-supervisor-rollback-$new" "$bin/ai-supervisor"
  printf 'supervisor restored to %s from %s\n' "$previous" "$backup"
  # Issue #1120: remove the version directory this attempt created (marked by upgrade-supervisor.sh), so the same commit can be retried.
  # Never the installed version, a directory a running process uses, or one that existed before the attempt (no marker).
  # PIDs of this process and its ancestors: the caller (for example the reconcile run) is not another user of the directory.
  self_and_ancestors() {
    local pid=$$ stat
    while [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null; do
      printf '%s\n' "$pid"
      stat=$(cat "/proc/$pid/stat" 2>/dev/null) || break
      stat=${stat##*) }
      stat=${stat#* }
      pid=${stat%% *}
    done
  }
  dir_in_use() {
    local dir=$1 alias=${2:-} p cwd cmd skip
    skip=" $(self_and_ancestors | tr '\n' ' ')"
    for p in /proc/[0-9]*; do
      case "$skip" in *" ${p#/proc/} "*) continue ;; esac
      cwd=$(readlink "$p/cwd" 2>/dev/null) || cwd=
      case "$cwd" in "$dir"|"$dir"/*) return 0 ;; esac
      if [ -n "$alias" ]; then case "$cwd" in "$alias"|"$alias"/*) return 0 ;; esac; fi
      cmd=$({ tr '\0' ' ' <"$p/cmdline"; } 2>/dev/null) || cmd=
      case "$cmd" in *"$dir/"*) return 0 ;; esac
      if [ -n "$alias" ]; then case "$cmd" in *"$alias/"*) return 0 ;; esac; fi
    done
    return 1
  }
  created="$state/versions/$new"; marker="$state/.created-$new"
  if [ ! -e "$marker" ]; then printf 'cleanup: version directory kept (it existed before the attempt)\n'
  elif [ "$new" = "$previous" ] || [ "$(readlink "$state/current")" = "versions/$new" ]; then printf 'cleanup: version directory kept (it is the installed version)\n'
  elif [ -L "$created" ] || [ ! -d "$created" ]; then printf 'cleanup: version directory kept (not a plain directory)\n'
  elif dir_in_use "$created" "$([ "$was_current" = "versions/$new" ] && printf '%s' "$state/current")"; then printf 'cleanup: version directory kept (in use by a running process)\n'
  else rm -rf -- "$created" && rm -f "$marker" && printf 'cleanup: removed version directory %s\n' "$new"; fi
  # Issue #946: put the MCP server copy of the restored version back (best effort; versions installed before this had none).
  if [ -f "$state/versions/$previous/tools/install-foreman-mcp.sh" ] && [ -d "$state/versions/$previous/foreman-mcp" ]; then
    AI_SUPERVISOR_STATE_DIR="$state" bash "$state/versions/$previous/tools/install-foreman-mcp.sh" "$state/versions/$previous" "$previous" || printf 'foreman-mcp restore failed\n' >&2
  fi
  # Issue #1144: migration 003 adds alerts.channel, which the previous version's validator rejects, and team.local.json lives
  # outside versions/. Take back exactly what 003 added so the restored version can load its configuration, and mark 003 as not
  # applied so a later install runs it again. A file that names anything else under alerts is left alone.
  # The script is fetched from the failed version on its own, so the undo is inline rather than a file beside it.
  undo='const fs = require("fs"), p = process.argv[1] + "/team.local.json", m = process.argv[1] + "/team/migrations.json";
    const local = JSON.parse(fs.readFileSync(p, "utf8")), a = local.alerts;
    if (!a || Object.keys(a).length !== 1 || a.channel !== "unraid") process.exit(0);
    delete local.alerts; fs.writeFileSync(p + ".tmp", JSON.stringify(local, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(p + ".tmp", p);
    try { const s = JSON.parse(fs.readFileSync(m, "utf8")); if (s.applied >= 3) { s.applied = 2; fs.writeFileSync(m, JSON.stringify(s) + "\n", { mode: 0o600 }); } } catch {}'
  if [ -f "$state/team.local.json" ]; then
    "$(command -v node || printf '/usr/local/bin/node')" -e "$undo" "$state" || printf 'alert channel migration not undone\n' >&2
  fi
  exit 0
fi
commit=${1:?usage: rollback-supervisor.sh COMMIT}
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 2
backup="/root/bin/ai-agent.before-supervisor-$commit"
[ -f "$backup" ] || { printf 'backup missing\n' >&2; exit 2; }
cp -p "$backup" /root/bin/ai-agent
bash -n /root/bin/ai-agent
printf 'launcher restored from %s; preserve supervisor state and review jobs before removing wrapper\n' "$backup"
