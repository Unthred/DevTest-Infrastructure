#!/usr/bin/env bash
# Foreman bootstrap installer (issue #101). Deliberately minimal and rarely changed: a change to this file is a needs-homeowner
# card, because it is the one part that cannot install itself. Everything else, including the main upgrader, installs through it.
#   bootstrap-install.sh check   REPO_URL SHA   clean copy from the remote, verify it is exactly SHA, run validator and full tests
#   bootstrap-install.sh install REPO_URL SHA   the same copy and verification, then the atomic swap (tools/upgrade-supervisor.sh)
# Exit codes: 0 ok (stdout "flaky tests: ..." when a failed first run passed file by file, issue #1322); 2 bad usage;
#             10 transient (clone, fetch or checkout failed: retry with backoff, never latch the commit);
#             11 validator or tests failed (blocks only this commit); 12 payload differs from the reviewed commit; 13 swap failed.
set -uo pipefail
umask 077
mode=${1:-}; url=${2:-}; sha=${3:-}
[[ "$mode" =~ ^(check|install)$ && -n "$url" && "$sha" =~ ^[0-9a-f]{40}$ ]] || { printf 'usage: bootstrap-install.sh check|install REPO_URL SHA\n' >&2; exit 2; }
scratch=$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-install.XXXXXX") || exit 10
trap 'rm -rf "$scratch"' EXIT
src="$scratch/src"
# The copy comes from the remote (GitHub), never from a local checkout, so unreviewed local edits cannot reach the install.
git clone --quiet --no-checkout "$url" "$src" || { printf 'clone failed\n' >&2; exit 10; }
git -C "$src" checkout --quiet --detach "$sha" || { printf 'checkout failed: %s is not available from the remote\n' "$sha" >&2; exit 10; }
[ "$(git -C "$src" rev-parse HEAD)" = "$sha" ] || { printf 'payload differs from the reviewed commit\n' >&2; exit 12; }
[ -z "$(git -C "$src" status --porcelain --ignored)" ] || { printf 'payload differs from the reviewed commit (unclean copy)\n' >&2; exit 12; }
cd "$src" || exit 10
node tools/validate-project.mjs >"$scratch/validate.log" 2>&1 || { printf 'validator: %s\n' "$(tail -n 3 "$scratch/validate.log" | tr '\n' ' ')" >&2; exit 11; }
# Failing-test report (issue #412). The TAP reporter lists every failure as "not ok N - name" followed by a YAML block. Children print
# before their parent, so an entry is a parent (a suite, "1 subtest failed") when the entry before it is indented deeper; only leaves
# are reported. Output: line 1 "tests failed: a; b" (up to 5 names), then "--- excerpt ---" and a bounded excerpt (40 lines, 3000 bytes).
report_failed_tests() {
  awk '
    { line[NR] = $0 }
    /^ *not ok [0-9]+ - / { n++; at[n] = NR; match($0, /^ */); ind[n] = RLENGTH; nm = $0; sub(/^ *not ok [0-9]+ - /, "", nm); name[n] = nm }
    END {
      for (i = 1; i <= n; i++) if (i == 1 || ind[i - 1] <= ind[i]) leaf[++m] = i
      names = ""
      for (k = 1; k <= m && k <= 5; k++) names = names (k > 1 ? "; " : "") name[leaf[k]]
      if (m > 5) names = names "; and " (m - 5) " more"
      if (m == 0) names = "unknown (no failing test found in the output)"
      printf "tests failed: %s\n--- excerpt ---\n", names
      lines = 0
      for (k = 1; k <= m && lines < 40; k++) for (j = at[leaf[k]]; j <= NR && lines < 40; j++) { print line[j]; lines++; if (line[j] ~ /^ *\.\.\.$/) break }
    }' "$1" | head -c 3000
}
# Repeat of failed files (issue #1322). A failure that goes away when its file runs alone is a fault of the test or the host, not of the
# commit. Prints the distinct test files (relative to the copy) holding a failure, one per line; prints "?" when a failure names no file.
failed_files() {
  awk -v root="$PWD/" '
    function add(f) { if (index(f, root) == 1) f = substr(f, length(root) + 1); if (!(f in seen)) { seen[f] = 1; order[++n] = f } }
    /^ *not ok [0-9]+ - / { if (open) bad = 1; open = 1; nm = $0; sub(/^ *not ok [0-9]+ - /, "", nm); next }
    open && /^ *location: / { f = $0; sub(/^ *location: .?/, "", f); sub(/(:[0-9]+)+.?$/, "", f); add(f); open = 0; next }
    open && nm ~ /\.test\.mjs$/ { add(nm); open = 0 }
    END { if (open || bad || n == 0) print "?"; for (i = 1; i <= n; i++) print order[i] }' "$1"
}
max_repeat=10
if ! node --test --test-reporter=tap 'tests/**/*.test.mjs' >"$scratch/tests.log" 2>&1; then
  mapfile -t failed < <(failed_files "$scratch/tests.log")
  if [ "${#failed[@]}" -eq 0 ] || [[ " ${failed[*]} " == *" ? "* ]] || [ "${#failed[@]}" -gt "$max_repeat" ]; then
    report_failed_tests "$scratch/tests.log" >&2; printf '\n' >&2; exit 11   # too many or unplaceable failures: real, no repeat
  fi
  : >"$scratch/alone.log"; alone_failed=0
  for f in "${failed[@]}"; do
    node --test --test-reporter=tap "$f" >"$scratch/one.log" 2>&1 || { alone_failed=1; cat "$scratch/one.log" >>"$scratch/alone.log"; }
  done
  [ "$alone_failed" = 0 ] || { report_failed_tests "$scratch/alone.log" >&2; printf '\n' >&2; exit 11; }
  # Every failed file passed alone: flaky. The upgrade code reads this stdout block and records the names.
  report_failed_tests "$scratch/tests.log" | sed '1s/^tests failed:/flaky tests:/'
fi
[ "$mode" = install ] || exit 0
# Re-verify immediately before the swap: the validator and tests must not have changed the copy.
[ "$(git rev-parse HEAD)" = "$sha" ] && [ -z "$(git status --porcelain)" ] || { printf 'payload differs from the reviewed commit\n' >&2; exit 12; }
bash tools/upgrade-supervisor.sh >"$scratch/swap.log" 2>&1 || { printf 'swap: %s\n' "$(tail -n 3 "$scratch/swap.log" | tr '\n' ' ')" >&2; exit 13; }
exit 0
