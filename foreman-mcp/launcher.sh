#!/bin/sh
# Forced command for the foreman-mcp account. Runs the server with Node's permission model so that even a bug cannot write outside the
# call-log directory and the inbox items directory: reads are limited to the server directory, /proc, /sys/fs/cgroup (container memory, issue #972), the configuration, the log directory and
# the inbox; writes go to the log directory and <inbox>/items only (issue #124).
# Paths are set by the installer in the sibling file launcher.env (not in Git); this script holds no host names or addresses.
DIR=$(dirname "$0")
. "$DIR/launcher.env" 2>/dev/null || exit 70
export FOREMAN_MCP_CONFIG="$CONFIG_FILE"
[ -n "$INBOX_DIR" ] && export FOREMAN_MCP_INBOX="$INBOX_DIR"
exec "$NODE_BIN" --permission --allow-fs-read="$DIR" --allow-fs-read=/proc --allow-fs-read=/sys/fs/cgroup --allow-fs-read="$CONFIG_FILE" --allow-fs-read="$LOG_DIR" ${REPORTS_DIR:+--allow-fs-read="$REPORTS_DIR"} --allow-fs-write="$LOG_DIR" \
  ${INBOX_DIR:+--allow-fs-read="$INBOX_DIR" --allow-fs-write="$INBOX_DIR/items"} \
  "$DIR/server.mjs"
