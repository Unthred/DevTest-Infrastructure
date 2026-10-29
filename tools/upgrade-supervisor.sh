#!/usr/bin/env bash
# Switch the opt-in wrapper to a reviewed committed version; existing jobs keep their state.
set -euo pipefail
source_root=$(git rev-parse --show-toplevel)
commit=$(git rev-parse HEAD)
[ -z "$(git status --porcelain)" ] || { printf 'worktree must be clean\n' >&2; exit 2; }
[ "$(id -u)" = 0 ] || exit 2
wrapper=/root/bin/ai-supervisor
[ -f "$wrapper" ] && [ -x "$wrapper" ] || { printf 'supervisor is not installed\n' >&2; exit 2; }
grep -Fq '    --supervisor) shift; exec /root/bin/ai-supervisor "$@" ;;' /root/bin/ai-agent || { printf 'launcher integration missing\n' >&2; exit 2; }
node --test "$source_root/tests/supervisor.test.mjs" >/dev/null
install_root="/root/lib/ai-supervisor-$commit"
[ ! -e "$install_root" ] || { printf 'version already installed\n' >&2; exit 2; }
mkdir -p "$install_root"
cp -a "$source_root/supervisor" "$install_root/"
chmod -R go-rwx "$install_root"
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
