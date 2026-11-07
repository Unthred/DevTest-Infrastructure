// Issue #1007: helper for tests whose server keeps writing into its state root for a moment after the test ends.
// The root is removed when the test ends and once more at the end of the file's run, after the writers have settled.
import fs from 'node:fs';
import { after } from 'node:test';

const roots = new Set();
after(async () => {
  await new Promise((r) => setTimeout(r, 500));
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  roots.clear();
});
export function removeLater(dir) { roots.add(dir); return dir; }
