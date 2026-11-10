#!/usr/bin/env bash
# Sourced by tools/upgrade-supervisor.sh (issue #1120). Decides what the swap does with versions/<commit> when it already exists.
# tools/rollback-supervisor.sh carries its own copy of dir_in_use because the dispatcher runs it as a single file.

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
# True when a running process (other than this one and its ancestors) has the directory (or the optional ALIAS, the current symlink that pointed at it) as its working directory or on its command line.
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

# prepare_version_dir STATE COMMIT: leave STATE/versions/COMMIT absent and record that this attempt will create it.
# Refuses (return 1, reason on stderr) only for the installed version or a directory a running process uses; any other leftover
# from an earlier attempt is removed so it is rebuilt from the reviewed commit.
prepare_version_dir() {
  local state=$1 commit=$2 dir="$1/versions/$2" installed
  rm -f -- "$state/.created-$commit"
  if [ -e "$dir" ] || [ -L "$dir" ]; then
    installed=$(readlink "$state/current" 2>/dev/null || true)
    if [ "$installed" = "versions/$commit" ]; then printf 'version already installed (it is the installed version)\n' >&2; return 1; fi
    if [ -L "$dir" ] || [ ! -d "$dir" ]; then printf 'version path is not a plain directory\n' >&2; return 1; fi
    if dir_in_use "$dir"; then printf 'version directory left by an earlier attempt is in use by a running process\n' >&2; return 1; fi
    rm -rf -- "$dir"
    printf 'leftover version directory from an earlier attempt removed; rebuilding\n'
    return 0
  fi
  # Only a directory this attempt creates is marked, so a rollback never removes one that existed before the attempt.
  : >"$state/.created-$commit"
}
