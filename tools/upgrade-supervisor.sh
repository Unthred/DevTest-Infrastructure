#!/usr/bin/env bash
# Switch the opt-in wrapper to a reviewed committed version; existing jobs keep their state.
set -euo pipefail
umask 077
source_root=$(git rev-parse --show-toplevel)
commit=$(git rev-parse HEAD)
[ -z "$(git status --porcelain)" ] || { printf 'worktree must be clean\n' >&2; exit 2; }
[ "$(id -u)" = 0 ] || exit 2
wrapper=/root/bin/ai-supervisor
[ -f "$wrapper" ] && [ -x "$wrapper" ] || { printf 'supervisor is not installed\n' >&2; exit 2; }
# The launcher dispatches --supervisor to /root/bin/ai-supervisor, either directly (as install-supervisor.sh patched it) or
# through the AI_AGENT_SUPERVISOR override that the AI-Rules launcher has used since 2026-10-31 (issue #83).
grep -Fq -e '    --supervisor) shift; exec /root/bin/ai-supervisor "$@" ;;' -e '    --supervisor) shift; exec "${AI_AGENT_SUPERVISOR:-/root/bin/ai-supervisor}" "$@" ;;' /root/bin/ai-agent || { printf 'launcher integration missing\n' >&2; exit 2; }
node --test "$source_root/tests/supervisor.test.mjs" >/dev/null
for directory in /mnt/cache/ai-supervisor /mnt/cache/ai-supervisor/versions; do
  [ ! -L "$directory" ] || { printf 'unsafe supervisor directory symlink\n' >&2; exit 2; }
done
install_root="/mnt/cache/ai-supervisor/versions/$commit"
[ ! -e "$install_root" ] || { printf 'version already installed\n' >&2; exit 2; }
mkdir -p "$install_root"
chmod 700 /mnt/cache/ai-supervisor /mnt/cache/ai-supervisor/versions "$install_root"
[ "$(stat -c '%u:%a' /mnt/cache/ai-supervisor)" = 0:700 ] || { printf 'unsafe supervisor state root\n' >&2; exit 2; }
# Local configuration lives in /mnt/cache/ai-supervisor/team.local.json (outside versions/); an upgrade never reads, writes or replaces it.
[ ! -e "$source_root/supervisor/team.local.json" ] || { printf 'team.local.json must not be in the versioned payload\n' >&2; exit 2; }
cp -a "$source_root/supervisor" "$install_root/"
diff -r "$source_root/supervisor" "$install_root/supervisor" >/dev/null || { printf 'installed payload differs from the reviewed commit\n' >&2; exit 2; }
# The MCP server and its installer travel with the version (issue #946), so a rollback can put the previous server copy back.
cp -a "$source_root/foreman-mcp" "$install_root/"
mkdir -p "$install_root/tools"; cp -a "$source_root/tools/install-foreman-mcp.sh" "$install_root/tools/"
diff -r "$source_root/foreman-mcp" "$install_root/foreman-mcp" >/dev/null || { printf 'installed MCP payload differs from the reviewed commit\n' >&2; exit 2; }
chmod -R go-rwx "$install_root"
current=/mnt/cache/ai-supervisor/current
if [ -e "$current" ] && [ ! -L "$current" ]; then printf 'current supervisor path is not a symlink\n' >&2; exit 2; fi
ln -s "versions/$commit" "/mnt/cache/ai-supervisor/.current-$commit"
mv -Tf "/mnt/cache/ai-supervisor/.current-$commit" "$current"
backup="/root/bin/ai-supervisor.before-$commit"
cp -p "$wrapper" "$backup"
temp="/root/bin/.ai-supervisor-$commit"
cat > "$temp" <<EOF
#!/usr/bin/env bash
exec /usr/local/bin/node '$install_root/supervisor/cli.mjs' "\$@"
EOF
chmod 755 "$temp"
mv "$temp" "$wrapper"
bash -n "$wrapper"
# team-status delegates to whichever ai-supervisor is current, so it survives every later upgrade and rollback unchanged.
status_cmd=/root/bin/team-status
status_tmp=/root/bin/.team-status-$commit
cat > "$status_tmp" <<'EOF'
#!/usr/bin/env bash
exec /root/bin/ai-supervisor team status "$@"
EOF
chmod 755 "$status_tmp"
bash -n "$status_tmp"
mv -f "$status_tmp" "$status_cmd"
# team-alert ships from the reviewed commit (issue #215), not as a hand-edited copy. Only the script is replaced; alert.state is
# runtime state beside it and is never read, written or removed here.
alert_dir=/mnt/cache/ai-supervisor/bin
[ ! -L "$alert_dir" ] || { printf 'unsafe team-alert directory symlink\n' >&2; exit 2; }
mkdir -p "$alert_dir"; chmod 700 "$alert_dir"
alert_tmp="$alert_dir/.team-alert-$commit"
cp "$source_root/bin/team-alert" "$alert_tmp"; chmod 755 "$alert_tmp"
bash -n "$alert_tmp"; cmp -s "$source_root/bin/team-alert" "$alert_tmp" || { printf 'installed team-alert differs from the reviewed commit\n' >&2; exit 2; }
mv -f "$alert_tmp" "$alert_dir/team-alert"
/root/bin/ai-agent --supervisor help >/dev/null
# Issue #946: update the Foreman MCP server copy. A failure here never undoes the supervisor swap: the installer restores the previous
# copy, records the failure in team/mcp-install.json, and the self-upgrade alerts on it.
bash "$source_root/tools/install-foreman-mcp.sh" "$source_root" "$commit" || printf 'foreman-mcp install failed; previous copy kept\n' >&2
printf 'upgraded=%s previous_wrapper=%s\n' "$commit" "$backup"
