// Issue #1368: upgrade.retry_install, the homeowner asks for one more install attempt of the commit the install tests refused.
// The command sets the same urgent request as `self-upgrade install-now` (the next install skips its wait) and marks the refused commit for one
// attempt; the next tick, not this command, runs it. Refused when no install is blocked. The state file is changed under upgrade.lock, so a
// tick in the middle of an install never writes its older copy back over the request.
import fs from 'node:fs';
import path from 'node:path';
import { upgradeLock } from '../../team.mjs';
import { readInstalled } from '../../suphealth.mjs';
import { atomicJson } from '../../core.mjs';
import { askRetry } from '../../upgrade-attempts.mjs';

export const RETRY_TARGET = 'install';

const refusal = (code, text) => ({ refusal_code: code, refusal_text: text });
const TARGET = { kind: 'upgrade', key: RETRY_TARGET, label: 'Blocked install', title: null, source: null, project: null, url: null };
const condition = (state, text = null) => ({ state, attention: 'none', reason_code: null, reason_text: text, since: null });

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function run(input, context) {
  const file = path.join(context.root, 'team', 'self-upgrade.json');
  const unlock = upgradeLock(context.root);
  if (!unlock) return refusal('install_running', 'An install step is running (upgrade.lock is held); try again when it has finished.');
  try {
    const asked = askRetry(readState(file), { installed: readInstalled(context.root).sha, now: context.now });
    if (!asked.ok) return refusal('nothing_blocked', `No install is blocked: ${asked.reason}.`);
    atomicJson(file, asked.state);
  } finally { unlock(); }
  context.wake?.('approve');   // an accepted trigger: requestWake refuses any other reason
  return { outcome: 'accepted', target: TARGET, before: condition('blocked'), after: condition('retry_requested'), undo: null, models: ['overview', 'appbar'] };
}

export const commands = [{
  name: 'upgrade.retry_install',
  tier: 'direct',
  reason_required: false,
  reversible: false,
  undo_command: null,
  inputs: [],
  refusals: ['nothing_blocked', 'install_running'],
  run,
}];
