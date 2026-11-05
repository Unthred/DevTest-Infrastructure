#!/bin/sh
# Forced command for the foreman-mcp account. Runs the server with Node's permission model so that even a bug cannot write outside the
# call-log directory: reads are limited to the server directory, /proc and the configuration; writes to the log directory only.
# Paths are set by the installer in the sibling file launcher.env (not in Git); this script holds no host names or addresses.
DIR=$(dirname "$0")
. "$DIR/launcher.env" 2>/dev/null || exit 70
export FOREMAN_MCP_CONFIG="$CONFIG_FILE"
exec "$NODE_BIN" --permission --allow-fs-read="$DIR" --allow-fs-read=/proc --allow-fs-read="$CONFIG_FILE" --allow-fs-read="$LOG_DIR" --allow-fs-write="$LOG_DIR" \
  "$DIR/server.mjs"
