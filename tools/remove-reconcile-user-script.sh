#!/usr/bin/env bash
# Remove only the supervisor's User Scripts schedule and script.
set -euo pipefail
umask 077
plugin_root=${AI_SUPERVISOR_USER_SCRIPTS_ROOT:-/boot/config/plugins/user.scripts}
script_dir="$plugin_root/scripts/AI Supervisor Reconcile"
schedule="$plugin_root/schedule.json"
cron="$plugin_root/customSchedule.cron"
if [ -z "${AI_SUPERVISOR_RECONCILE_TEST:-}" ]; then [ "$(id -u)" = 0 ] || exit 2; fi
[ -f "$schedule" ] && [ -f "$cron" ] && [ -f "$script_dir/script" ] || { printf 'reconcile installation missing\n' >&2; exit 2; }
if [ -z "${AI_SUPERVISOR_RECONCILE_TEST:-}" ]; then
  backup_dir="/mnt/cache/ai-supervisor/backups/user-scripts-remove-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$backup_dir"; chmod 700 "$backup_dir"
  cp -p "$schedule" "$cron" "$backup_dir/"
fi
node - "$plugin_root" "$script_dir" <<'NODE'
const fs = require('fs'), path = require('path');
const [root, dir] = process.argv.slice(2), script = path.join(dir, 'script');
const scheduleFile = path.join(root, 'schedule.json'), cronFile = path.join(root, 'customSchedule.cron');
const schedules = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
const entry = schedules[script];
if (!entry || entry.id !== 'scheduleAiSupervisorReconcile' || entry.custom !== '*/5 * * * *') throw new Error('schedule entry changed; manual review required');
const line = `*/5 * * * * /usr/local/emhttp/plugins/user.scripts/startCustom.php ${script} > /dev/null 2>&1`;
const cron = fs.readFileSync(cronFile, 'utf8');
if (cron.split('\n').filter(x => x === line).length !== 1) throw new Error('cron entry changed; manual review required');
const source = fs.readFileSync(script, 'utf8');
if (!source.includes('/mnt/cache/ai-supervisor/current/supervisor/cli.mjs reconcile')) throw new Error('script changed; manual review required');
function atomic(file, content) { const temp = `${file}.ai-supervisor-${process.pid}`; fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
delete schedules[script];
atomic(scheduleFile, JSON.stringify(schedules, null, 2) + '\n');
atomic(cronFile, cron.split('\n').filter(x => x !== line).join('\n'));
if (root === '/boot/config/plugins/user.scripts' && fs.existsSync('/tmp/user.scripts/schedule.json')) atomic('/tmp/user.scripts/schedule.json', JSON.stringify(schedules, null, 2) + '\n');
for (const file of ['script', 'name', 'description']) fs.unlinkSync(path.join(dir, file));
fs.rmdirSync(dir);
NODE
if [ -z "${AI_SUPERVISOR_RECONCILE_TEST:-}" ]; then
  /usr/local/sbin/update_cron
  if crontab -c /etc/cron.d -l | grep -Fq "$script_dir/script"; then printf 'cron entry remains\n' >&2; exit 2; fi
  printf 'reconcile schedule removed; backup=%s\n' "$backup_dir"
else
  printf 'reconcile schedule test removal complete\n'
fi
