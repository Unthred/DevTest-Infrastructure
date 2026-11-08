// Issue #1007: helper for tests whose server keeps writing into its state root for a moment after the test ends.
// The root is removed when the test ends and once more at the end of the file's run, after the writers have settled.
import fs from 'node:fs';
import { after } from 'node:test';
import { spawnSync } from 'node:child_process';

const roots = new Set();
// A detached worker can still write after its test ended and recreate the folder: stop whatever has the folder in its command line, then
// remove until the folder stays gone for a while.
const gone = d => !fs.existsSync(d);
after(async () => {
  await new Promise((r) => setTimeout(r, 500));
  for (const d of roots) {
    for (let i = 0; i < 12; i++) {
      spawnSync('pkill', ['-9', '-f', d], { stdio: 'ignore' });
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* retried */ }
      await new Promise((r) => setTimeout(r, 250));
      if (gone(d)) break;
    }
  }
  roots.clear();
});
export function removeLater(dir) { roots.add(dir); return dir; }
