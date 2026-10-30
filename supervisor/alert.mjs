import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SupervisorError } from './core.mjs';

// Alerts (#47, #50). Every alert is appended to <state root>/team/alerts.jsonl with its delivery result. Delivery uses
// alerts.command from team.local.json (an absolute program plus arguments, text on stdin, so no secret is ever an argument);
// without it, the Unraid notify script that feeds the AI channel is used. With neither, delivery FAILS (delivered=false and
// an error), so callers see that nothing reached the channel and can retry.
export const UNRAID_NOTIFY = '/usr/local/emhttp/plugins/dynamix/scripts/notify';
export function alertSender(root, config, { notify = UNRAID_NOTIFY, run = spawnSync } = {}) {
  return async text => {
    const dir = path.join(root, 'team'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const haveNotify = !config.alerts && fs.existsSync(notify);
    let delivered = false;
    if (config.alerts) {
      const [program, ...rest] = config.alerts.command;
      delivered = run(program, rest, { input: text, encoding: 'utf8', timeout: 30000, env }).status === 0;
    } else if (haveNotify) {
      delivered = run(notify, ['-e', 'AI agent team', '-s', 'Tower | Agents need the homeowner', '-d', text.slice(0, 500), '-i', 'warning'], { encoding: 'utf8', timeout: 30000, env }).status === 0;
    }
    fs.appendFileSync(path.join(dir, 'alerts.jsonl'), JSON.stringify({ at: Date.now(), text, delivered }) + '\n', { mode: 0o600 });
    if (!delivered) throw new SupervisorError(config.alerts || haveNotify ? 'alert command failed' : 'no alert channel configured');
  };
}
