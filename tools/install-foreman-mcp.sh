#!/usr/bin/env bash
# Install foreman-mcp/ from a reviewed commit into the server's install directory (issue #946). Run by tools/upgrade-supervisor.sh
# after the supervisor swap and by tools/rollback-supervisor.sh to restore the previous copy. Usage: install-foreman-mcp.sh SOURCE_ROOT COMMIT
# SOURCE_ROOT holds foreman-mcp/ (a checkout, or versions/<sha>). The install directory comes from <state>/foreman-mcp.install, one line
# `INSTALL_DIR=/absolute/path`, written by the homeowner; without that file nothing is installed (result "skipped"). The copy lives at
# <INSTALL_DIR>/foreman-mcp with the commit in <INSTALL_DIR>/VERSION (the layout of docs/foreman-mcp.md). launcher.env is local
# configuration: it is carried over from the previous copy and never replaced. Code is root-owned, dirs 0755, files 0644, launcher.sh 0755,
# so the restricted account only reads it. The swap is two renames; on any failure the previous copy is put back and the exit is 1.
# Result: one JSON line on stdout and in <state>/team/mcp-install.json: skipped | unchanged | installed | failed.
set -uo pipefail
umask 022
src_root=${1:-}; commit=${2:-}
state=${AI_SUPERVISOR_STATE_DIR:-/mnt/cache/ai-supervisor}
[ -d "$src_root/foreman-mcp" ] && [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { printf 'usage: install-foreman-mcp.sh SOURCE_ROOT COMMIT\n' >&2; exit 2; }
result() {   # result KIND REASON
  local line; line=$(printf '{"sha":"%s","result":"%s","reason":"%s","at":%s000}' "$commit" "$1" "$(printf '%s' "$2" | tr -d '"\\\n' | cut -c1-200)" "$(date +%s)")
  printf '%s\n' "$line"
  mkdir -p "$state/team" 2>/dev/null && { printf '%s\n' "$line" > "$state/team/.mcp-install.tmp" && mv -f "$state/team/.mcp-install.tmp" "$state/team/mcp-install.json"; } 2>/dev/null
  return 0
}
conf="$state/foreman-mcp.install"
[ -f "$conf" ] || { result skipped 'no foreman-mcp.install file: the MCP server is not set up for automatic installs'; exit 0; }
dir=$(sed -n 's/^INSTALL_DIR=//p' "$conf" | head -n 1)
[[ "$dir" == /* && "$dir" != *..* && ! -L "$dir" && -d "$dir" ]] || { result failed 'INSTALL_DIR is not an existing absolute directory'; exit 1; }
live="$dir/foreman-mcp"
[ -d "$live" ] && [ ! -L "$live" ] || { result skipped 'foreman-mcp is not installed by hand yet; nothing to update'; exit 0; }
new="$dir/.foreman-mcp.new-$commit"; prev="$dir/.foreman-mcp.prev-$commit"
rm -rf "$new" "$prev"
same() { diff -r -x launcher.env "$1" "$2" >/dev/null 2>&1; }
write_version() { printf '%s\n' "$commit" > "$dir/.VERSION.tmp" && chmod 644 "$dir/.VERSION.tmp" && mv -f "$dir/.VERSION.tmp" "$dir/VERSION"; }
if same "$src_root/foreman-mcp" "$live"; then
  write_version || { result failed 'could not record VERSION'; exit 1; }
  result unchanged 'foreman-mcp/ already matches this commit'; exit 0
fi
fail() { rm -rf "$new"; [ -d "$prev" ] && [ ! -e "$live" ] && mv "$prev" "$live"; result failed "$1"; exit 1; }
cp -a "$src_root/foreman-mcp" "$new" || fail 'copy failed'
rm -f "$new/launcher.env"
[ ! -f "$live/launcher.env" ] || cp -p "$live/launcher.env" "$new/launcher.env" || fail 'could not carry launcher.env over'
find "$new" -type d -exec chmod 755 {} + && find "$new" -type f ! -name launcher.env -exec chmod 644 {} + && chmod 755 "$new/launcher.sh" || fail 'chmod failed'
[ "$(id -u)" != 0 ] || chown -R root:root "$new" || fail 'chown failed'
same "$src_root/foreman-mcp" "$new" || fail 'copy differs from the reviewed commit'
command -v node >/dev/null 2>&1 && { node --check "$new/server.mjs" >/dev/null 2>&1 || fail 'server.mjs does not parse'; }
mv "$live" "$prev" || fail 'could not move the previous copy aside'
mv "$new" "$live" || { mv "$prev" "$live"; fail 'could not move the new copy into place'; }
same "$src_root/foreman-mcp" "$live" || { rm -rf "$live"; mv "$prev" "$live"; fail 'installed copy differs from the reviewed commit; previous copy restored'; }
write_version || { rm -rf "$live"; mv "$prev" "$live"; fail 'could not record VERSION; previous copy restored'; }
rm -rf "$prev"
result installed 'foreman-mcp/ updated'
exit 0
