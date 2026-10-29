#!/usr/bin/env bash
# Opt-in Tower installation. Run only after reviewing the source and diff.
set -euo pipefail
umask 077
source_root=$(git rev-parse --show-toplevel)
commit=$(git rev-parse HEAD)
if [ -n "$(git status --porcelain)" ]; then printf 'worktree must be clean before installation\n' >&2; exit 2; fi
install_root="/mnt/cache/ai-supervisor/versions/$commit"
launcher=/root/bin/ai-agent
wrapper=/root/bin/ai-supervisor
backup="/root/bin/ai-agent.before-supervisor-$commit"
[ "$(id -u)" = 0 ] || { printf 'root required\n' >&2; exit 2; }
[ -f "$launcher" ] && [ -x "$launcher" ] || { printf 'live launcher missing\n' >&2; exit 2; }
[ ! -e "$install_root" ] && [ ! -e "$wrapper" ] || { printf 'already installed or conflicting path\n' >&2; exit 2; }
for directory in /mnt/cache/ai-supervisor /mnt/cache/ai-supervisor/versions; do
  [ ! -L "$directory" ] || { printf 'unsafe supervisor directory symlink\n' >&2; exit 2; }
done
node --test "$source_root/tests/supervisor.test.mjs" >/dev/null
bash -n "$launcher"
mkdir -p "$install_root"
chmod 700 /mnt/cache/ai-supervisor /mnt/cache/ai-supervisor/versions "$install_root"
[ "$(stat -c '%u:%a' /mnt/cache/ai-supervisor)" = 0:700 ] || { printf 'unsafe supervisor state root\n' >&2; exit 2; }
cp -a "$source_root/supervisor" "$install_root/"
chmod -R go-rwx "$install_root"
current=/mnt/cache/ai-supervisor/current
[ ! -e "$current" ] && [ ! -L "$current" ] || { printf 'current supervisor link already exists\n' >&2; exit 2; }
ln -s "versions/$commit" "$current"
cp -p "$launcher" "$backup"
node - "$launcher" <<'NODE'
const fs = require('fs');
const file = process.argv[2], text = fs.readFileSync(file, 'utf8');
const needle = '    --recover) shift; recover "$@" ;;';
if (!text.includes(needle) || text.includes('    --supervisor) shift; exec /root/bin/ai-supervisor "$@" ;;')) throw new Error('launcher anchor missing or already patched');
let updated = text.replace(needle, `${needle}\n    --supervisor) shift; exec /root/bin/ai-supervisor "$@" ;;`);
updated = updated.replace('Usage: ai [--help|--list|--manage|--recover <role> <engine> [slot]]', 'Usage: ai [--help|--list|--manage|--recover <role> <engine> [slot]]\n       ai --supervisor <command> [options]');
fs.writeFileSync(file, updated);
NODE
cat > "$wrapper" <<EOF
#!/usr/bin/env bash
exec /usr/local/bin/node '$install_root/supervisor/cli.mjs' "\$@"
EOF
chmod 755 "$wrapper"
bash -n "$launcher" "$wrapper"
"$launcher" --supervisor help >/dev/null
printf 'installed=%s backup=%s\n' "$commit" "$backup"
