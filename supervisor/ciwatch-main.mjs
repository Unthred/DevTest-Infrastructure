// Issue #1411: the watcher process, `ciwatch-main.mjs PR SHA --state-root ROOT`, started detached by the tick (supervisor/ciwatch.mjs).
// It reads the head with the real `gh`, and when the checks finish asks for the `ci` wake exactly as a job end does: one request, no
// decision, no job. Any failure here only loses the speed-up; the scheduled pass is the fallback.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghRunner } from './github.mjs';
import { loadTeamConfig } from './team.mjs';
import { requestWake, spawnDetachedPass, WAKE_MAX_PER_HOUR } from './wake.mjs';
import { runWatch, POLL_MS } from './ciwatch.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const num = v => (v !== undefined && v !== '' && Number(v) >= 0 ? Number(v) : null);

export function watchCommand({ root, pr, sha, gh = ghRunner(), env = process.env, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const config = loadTeamConfig(path.join(dir, 'team.json'), root);
  const cap = num(env.AI_SUPERVISOR_WAKE_MAX_PER_HOUR) ?? WAKE_MAX_PER_HOUR;
  const pollMs = num(env.AI_SUPERVISOR_CI_WATCH_POLL_MS) || POLL_MS;
  const readHead = () => JSON.parse(gh(['pr', 'view', String(pr), '--repo', config.repository, '--json', 'state,headRefOid,statusCheckRollup']) || 'null');
  const wake = () => {
    if (!config.enabled) return;
    requestWake({ root, reason: 'ci', cap, spawnPass: reason => spawnDetachedPass({ root, reason, self: path.join(dir, 'cli.mjs') }) });
  };
  return runWatch({ root, pr, sha, readHead, wake, sleep, pollMs });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pr, sha, flag, root] = process.argv.slice(2);
  if (!Number.isInteger(Number(pr)) || !/^[0-9a-f]{7,64}$/i.test(String(sha)) || flag !== '--state-root' || !root) process.exit(2);
  watchCommand({ root, pr: Number(pr), sha }).then(() => process.exit(0), () => process.exit(1));
}
