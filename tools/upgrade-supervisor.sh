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
grep -Fq '    --supervisor) shift; exec /root/bin/ai-supervisor "$@" ;;' /root/bin/ai-agent || { printf 'launcher integration missing\n' >&2; exit 2; }
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
/root/bin/ai-agent --supervisor help >/dev/null
printf 'upgraded=%s previous_wrapper=%s\n' "$commit" "$backup"
