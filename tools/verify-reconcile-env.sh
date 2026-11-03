#!/usr/bin/env bash
# Enable gate for the reconcile schedule (issue #40). Usage: verify-reconcile-env.sh PATH HOME NODE CLI
# Runs, under the empty cron environment (env -i) with the pinned PATH and from a neutral directory (not the caller's cwd):
#   1. `preflight`: git repo root, gh access, decision register read and D-020 approval, both providers' preflights
#      (run against the configured product repository);
#   2. `team tick --dry-run`: the live tick's own planning path (gh reads, register read, D-020 check) without any effect.
# Exit 0 only when both pass, the dry run exits 0 and returns a real plan (JSON on stdout, an `actions` array, no string `skipped`).
# Limit: a dry run never reaches reconcileOnce, selfUpgradeBefore/After or the pending config migrations (live ticks only), so a failure
# specific to those under the cron environment is not caught here (docs/supervisor.md). Read-only; no model call; no secret is printed.
set -uo pipefail
[ "$#" = 4 ] || { printf 'usage: verify-reconcile-env.sh PATH HOME NODE CLI\n' >&2; exit 2; }
run_path=$1; run_home=$2; node_bin=$3; cli=$4
[ -x "$node_bin" ] || { printf 'enable gate: node not executable: %s\n' "$node_bin" >&2; exit 2; }
[ -r "$cli" ] || { printf 'enable gate: supervisor cli unreadable: %s\n' "$cli" >&2; exit 2; }
cd / || exit 2
gate() { env -i PATH="$run_path" HOME="$run_home" "$node_bin" "$cli" "$@" 2>&1; }
fail() { printf 'enable gate failed at %s: %s\n' "$1" "$(printf '%s' "$2" | tail --bytes=1500 | tr '\n' ' ')" >&2; exit 1; }
out=$(gate preflight) || fail "preflight (rc=$?)" "$out"
# The tick runs with stdout and stderr apart: only stdout is the plan, and its exit code counts (as in supervisor/upgrade.mjs dryRunTick).
tick_err=$(mktemp) || exit 2
trap 'rm -f "$tick_err"' EXIT
out=$(env -i PATH="$run_path" HOME="$run_home" "$node_bin" "$cli" team tick --dry-run 2>"$tick_err"); rc=$?
[ "$rc" = 0 ] || fail "team tick --dry-run (rc=$rc)" "$out $(cat "$tick_err")"
# Only a real plan counts: stdout is JSON with an "actions" array and no string "skipped". Not a lock skip, a stray line or a nested key.
# A here-string, not a pipe: under pipefail a checker that exits before reading all of stdin would make printf die of SIGPIPE and fail a valid plan.
if ! "$node_bin" -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{const o=JSON.parse(t);process.exit(Array.isArray(o?.actions)&&typeof o?.skipped!=="string"?0:1)}catch{process.exit(1)}})' <<<"$out"; then
  case "$out" in
    *'another tick is running'*) fail 'team tick --dry-run (no plan returned: another tick holds the tick lock; retry in a minute)' "$out" ;;
    *) fail 'team tick --dry-run (no plan returned)' "$out $(cat "$tick_err")" ;;
  esac
fi
printf 'enable gate passed\n'
