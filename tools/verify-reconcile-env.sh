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
# Issue #581: the tick and its plan check are attempted twice (a transient failure under load must not refuse a good commit), and the
# failure text of the last attempt carries the tick's stderr and the checker's own stderr, never a bare "no plan returned".
tick_err=$(mktemp) || exit 2
chk_err=$(mktemp) || exit 2
trap 'rm -f "$tick_err" "$chk_err"' EXIT
# Only a real plan counts: stdout is JSON with an "actions" array and no string "skipped". Not a lock skip, a stray line or a nested key.
# The plan goes in by here-string, not a pipe: under pipefail a checker that exits before reading stdin made printf die of SIGPIPE (141) and a good plan fail.
check_plan() { "$node_bin" -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{const o=JSON.parse(t);if(Array.isArray(o?.actions)&&typeof o?.skipped!=="string")process.exit(0);console.error("plan check: "+(typeof o?.skipped==="string"?"skipped: "+o.skipped:"no actions array"))}catch(e){console.error("plan check: not JSON: "+e.message)}process.exit(1)})' <<<"$1" 2>"$chk_err"; }
attempt=1
while :; do
  out=$(env -i PATH="$run_path" HOME="$run_home" "$node_bin" "$cli" team tick --dry-run 2>"$tick_err"); rc=$?
  if [ "$rc" = 0 ] && check_plan "$out"; then break; fi
  [ "$attempt" -lt 2 ] || break
  attempt=2; sleep "${VERIFY_RETRY_DELAY:-5}"
done
[ "$rc" = 0 ] || fail "team tick --dry-run (rc=$rc)" "$out $(cat "$tick_err")"
if ! check_plan "$out"; then
  case "$out" in
    *'another tick is running'*) fail 'team tick --dry-run (no plan returned: another tick holds the tick lock; retry in a minute)' "$out $(cat "$chk_err")" ;;
    *) fail 'team tick --dry-run (no plan returned)' "$out $(cat "$tick_err") $(cat "$chk_err")" ;;
  esac
fi
printf 'enable gate passed\n'
