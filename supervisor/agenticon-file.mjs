// Issue #1311: reads an agent's icon file from <state root>/agent-icons/<agent>.svg. The agent is looked up in the configured agent ids only,
// so request text is never joined to a directory. The file is read each time it is asked for: no timer, no stored copy. The one thing kept is
// which file change was already logged, so a refused file is reported once per change and not on every request.
import fs from 'node:fs';
import path from 'node:path';
import { checkIcon, MAX_ICON_BYTES } from './agenticon.mjs';

export const ICON_DIR = 'agent-icons';
export const iconRoute = agent => `/api/v1/agent-icon/${agent}`;

const logged = new Map();
const configuredIds = config => Object.keys(config?.agents ?? {});

function logOnce(file, stat, reason) {
  const signature = `${stat.mtimeMs}:${stat.size}`;
  if (logged.get(file) === signature) return;
  logged.set(file, signature);
  console.error(`agent icon ${file} refused: ${reason}`);
}

// Returns the SVG text, or null when the agent is not configured, the file is missing, or the file is not acceptable.
export function readAgentIcon(root, config, agent) {
  if (!configuredIds(config).includes(agent)) return null;
  const file = path.join(root, ICON_DIR, `${agent}.svg`);
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  // Read one byte past the limit, so an oversized file is refused without reading all of it.
  const handle = fs.openSync(file, 'r');
  let text;
  try {
    const buffer = Buffer.alloc(MAX_ICON_BYTES + 1);
    const count = fs.readSync(handle, buffer, 0, buffer.length, 0);
    text = buffer.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(handle); }
  const verdict = checkIcon(text);
  if (!verdict.ok) {
    logOnce(file, stat, verdict.reason);
    return null;
  }
  logged.delete(file);
  return text;
}
