#!/usr/bin/env bash
# Enable gate for the reconcile schedule (issue #40). Usage: verify-reconcile-env.sh PATH HOME NODE CLI
# Runs, under the empty cron environment (env -i) with the pinned PATH and from a neutral directory (not the caller's cwd):
#   1. `preflight`: git repo root, gh access, decision register read and D-020 approval, both providers' preflights
#      (run against the configured product repository);
#   2. `team tick --dry-run`: the live tick's own planning path (gh reads, register read, D-020 check) without any effect.
# Exit 0 only when both pass and the dry run returned a real plan. Read-only; no model call; no secret is printed.
set -uo pipefail
[ "$#" = 4 ] || { printf 'usage: verify-reconcile-env.sh PATH HOME NODE CLI\n' >&2; exit 2; }
run_path=$1; run_home=$2; node_bin=$3; cli=$4
[ -x "$node_bin" ] || { printf 'enable gate: node not executable: %s\n' "$node_bin" >&2; exit 2; }
[ -r "$cli" ] || { printf 'enable gate: supervisor cli unreadable: %s\n' "$cli" >&2; exit 2; }
cd / || exit 2
gate() { env -i PATH="$run_path" HOME="$run_home" "$node_bin" "$cli" "$@" 2>&1; }
fail() { printf 'enable gate failed at %s: %s\n' "$1" "$(printf '%s' "$2" | tail --bytes=1500 | tr '\n' ' ')" >&2; exit 1; }
out=$(gate preflight) || fail "preflight (rc=$?)" "$out"
out=$(gate team tick --dry-run) || fail "team tick --dry-run (rc=$?)" "$out"
# Only a real plan counts (it has an "actions" list): not a lock skip, not unparsable output.
printf '%s' "$out" | grep -q '"actions"' || fail 'team tick --dry-run (no plan returned)' "$out"
printf 'enable gate passed\n'
