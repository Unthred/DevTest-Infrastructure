#!/usr/bin/env bash
set -euo pipefail
commit=${1:?usage: rollback-supervisor.sh COMMIT}
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 2
backup="/root/bin/ai-agent.before-supervisor-$commit"
[ -f "$backup" ] || { printf 'backup missing\n' >&2; exit 2; }
cp -p "$backup" /root/bin/ai-agent
bash -n /root/bin/ai-agent
printf 'launcher restored from %s; preserve supervisor state and review jobs before removing wrapper\n' "$backup"
