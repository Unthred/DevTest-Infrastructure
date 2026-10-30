#!/usr/bin/env bash
# Add one scoped User Scripts schedule; preserve every existing entry.
set -euo pipefail
umask 077
plugin_root=${AI_SUPERVISOR_USER_SCRIPTS_ROOT:-/boot/config/plugins/user.scripts}
script_dir="$plugin_root/scripts/AI Supervisor Reconcile"
schedule="$plugin_root/schedule.json"
cron="$plugin_root/customSchedule.cron"
if [ -z "${AI_SUPERVISOR_RECONCILE_TEST:-}" ]; then [ "$(id -u)" = 0 ] || exit 2; fi
[ -f "$schedule" ] && [ -f "$cron" ] && [ -d "$plugin_root/scripts" ] || { printf 'User Scripts configuration missing\n' >&2; exit 2; }
[ ! -e "$script_dir" ] || { printf 'reconcile script already exists\n' >&2; exit 2; }
if [ -z "${AI_SUPERVISOR_RECONCILE_TEST:-}" ]; then
  [ -r /mnt/cache/ai-supervisor/current/supervisor/cli.mjs ] || { printf 'durable supervisor is missing\n' >&2; exit 2; }
  backup_dir="/mnt/cache/ai-supervisor/backups/user-scripts-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"
  cp -p "$schedule" "$cron" "$backup_dir/"
fi
# The cron environment has almost no PATH (issue #35: gh and codex were not found and every tick failed silently).
# Build an explicit PATH from where each required binary actually is today, then pin it in the generated script.
node_bin=${AI_SUPERVISOR_NODE:-$(command -v node || true)}
cli=${AI_SUPERVISOR_CLI:-/mnt/cache/ai-supervisor/current/supervisor/cli.mjs}
log=${AI_SUPERVISOR_LOG:-/mnt/cache/ai-supervisor/reconcile.log}
run_home=${AI_SUPERVISOR_RUN_HOME:-/root}
[ -n "$node_bin" ] && [ -x "$node_bin" ] || { printf 'node not found\n' >&2; exit 2; }
run_path=""
for bin in "$node_bin" "$(command -v gh || true)" "$(command -v git || true)" "$(command -v codex || true)" "$(command -v claude || true)" "$(command -v flock || true)"; do
  [ -n "$bin" ] || continue
  d=$(dirname "$bin"); case ":$run_path:" in *":$d:"*) ;; *) run_path="${run_path:+$run_path:}$d" ;; esac
done
for d in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do case ":$run_path:" in *":$d:"*) ;; *) run_path="$run_path:$d" ;; esac; done
for need in gh git flock; do PATH="$run_path" command -v "$need" >/dev/null || { printf 'required binary not found for the cron PATH: %s\n' "$need" >&2; exit 2; }; done
mkdir "$script_dir"
chmod 700 "$script_dir"
printf 'AI Supervisor Reconcile\n' > "$script_dir/name"
printf 'Bounded recovery check for opt-in AI supervisor jobs; no model call unless a verified eligible job is due.\n' > "$script_dir/description"
{
  printf '#!/bin/bash\n# BEGIN-ENV\nPATH=%q\nHOME=%q\nNODE=%q\nCLI=%q\nLOG=%q\n# END-ENV\n' "$run_path" "$run_home" "$node_bin" "$cli" "$log"
  cat <<'SCRIPT'
export PATH HOME
[ -r "$CLI" ] || exit 0
[ -x "$NODE" ] || exit 0
mkdir -p "$(dirname "$LOG")"
# One run at a time; an overlapping run skips instead of racing the log trim.
exec 9>"$LOG.lock"
flock -n 9 || exit 0
out=$("$NODE" "$CLI" reconcile 2>&1 | tail --bytes=2000 | tr '\n' ' '; exit "${PIPESTATUS[0]}")
rc=$?
printf '%s rc=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc" "$out" >> "$LOG"
# Trim only above the threshold, under the lock held above.
if [ "$(stat -c %s "$LOG")" -gt 1048576 ]; then tail --bytes=262144 "$LOG" | tail -n +2 > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
exit 0
SCRIPT
} > "$script_dir/script"
chmod 600 "$script_dir"/*
# Enable gate: run the preflight under the cron environment (env -i + the pinned PATH). If a binary or a login is not
# visible there, refuse before any schedule is written.
if [ -z "${AI_SUPERVISOR_RECONCILE_TEST:-}" ] || [ -n "${AI_SUPERVISOR_VERIFY:-}" ]; then
  if ! bash "$(dirname "$0")/verify-reconcile-env.sh" "$script_dir/script"; then
    rm -rf "$script_dir"; printf 'cron-environment preflight failed; nothing was scheduled\n' >&2; exit 3
  fi
fi
node - "$plugin_root" "$script_dir/script" <<'NODE'
const fs = require('fs'), path = require('path');
const [root, script] = process.argv.slice(2);
const scheduleFile = path.join(root, 'schedule.json'), cronFile = path.join(root, 'customSchedule.cron');
const schedules = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
if (Object.hasOwn(schedules, script)) throw new Error('schedule entry already exists');
const frequency = '*/5 * * * *';
schedules[script] = { script, frequency: 'custom', id: 'scheduleAiSupervisorReconcile', custom: frequency };
const line = `${frequency} /usr/local/emhttp/plugins/user.scripts/startCustom.php ${script} > /dev/null 2>&1`;
const cron = fs.readFileSync(cronFile, 'utf8');
if (cron.includes(line)) throw new Error('cron entry already exists');
function atomic(file, content) { const temp = `${file}.ai-supervisor-${process.pid}`; fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
atomic(scheduleFile, JSON.stringify(schedules, null, 2) + '\n');
atomic(cronFile, cron.replace(/\s*$/, '\n') + line + '\n');
if (root === '/boot/config/plugins/user.scripts' && fs.existsSync('/tmp/user.scripts/schedule.json'))
  atomic('/tmp/user.scripts/schedule.json', JSON.stringify(schedules, null, 2) + '\n');
NODE
if [ -z "${AI_SUPERVISOR_RECONCILE_TEST:-}" ]; then
  /usr/local/sbin/update_cron
  crontab -c /etc/cron.d -l | grep -Fq "$script_dir/script"
  printf 'reconcile schedule installed; backup=%s\n' "$backup_dir"
else
  printf 'reconcile schedule test install complete\n'
fi
