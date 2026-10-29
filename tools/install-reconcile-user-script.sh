#!/usr/bin/env bash
# Add one scoped User Scripts schedule; preserve every existing entry.
set -euo pipefail
umask 077
plugin_root=${AI_SUPERVISOR_USER_SCRIPTS_ROOT:-/boot/config/plugins/user.scripts}
script_dir="$plugin_root/scripts/AI Supervisor Reconcile"
schedule="$plugin_root/schedule.json"
cron="$plugin_root/customSchedule.cron"
[ "$(id -u)" = 0 ] || exit 2
[ -f "$schedule" ] && [ -f "$cron" ] && [ -d "$plugin_root/scripts" ] || { printf 'User Scripts configuration missing\n' >&2; exit 2; }
[ ! -e "$script_dir" ] || { printf 'reconcile script already exists\n' >&2; exit 2; }
if [ -z "${AI_SUPERVISOR_RECONCILE_TEST:-}" ]; then
  [ -r /mnt/cache/ai-supervisor/current/supervisor/cli.mjs ] || { printf 'durable supervisor is missing\n' >&2; exit 2; }
  backup_dir="/mnt/cache/ai-supervisor/backups/user-scripts-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"
  cp -p "$schedule" "$cron" "$backup_dir/"
fi
mkdir "$script_dir"
chmod 700 "$script_dir"
printf 'AI Supervisor Reconcile\n' > "$script_dir/name"
printf 'Bounded recovery check for opt-in AI supervisor jobs; no model call unless a verified eligible job is due.\n' > "$script_dir/description"
cat > "$script_dir/script" <<'SCRIPT'
#!/bin/bash
[ -r /mnt/cache/ai-supervisor/current/supervisor/cli.mjs ] || exit 0
[ -x /usr/local/bin/node ] || exit 0
/usr/local/bin/node /mnt/cache/ai-supervisor/current/supervisor/cli.mjs reconcile
SCRIPT
chmod 600 "$script_dir"/*
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
  bash "$script_dir/script" >/dev/null
  crontab -c /etc/cron.d -l | grep -Fq "$script_dir/script"
  printf 'reconcile schedule installed; backup=%s\n' "$backup_dir"
else
  printf 'reconcile schedule test install complete\n'
fi
