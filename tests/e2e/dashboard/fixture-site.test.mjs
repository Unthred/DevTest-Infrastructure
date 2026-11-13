import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from '../../helpers/tmp.mjs';
import { buildFixtureSite } from './fixture-site.mjs';

test('dashboard e2e fixture pages cover valid, empty and malformed dashboard state', async () => {
  const base = tmpDir('dashboard-e2e-fixture-');
  for (const variant of ['valid', 'long', 'empty', 'malformed']) {
    const root = path.join(base, variant, 'state');
    const site = path.join(base, variant, 'site');
    fs.mkdirSync(site, { recursive: true });
    await buildFixtureSite({ root, site, variant });
    const page = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
    if (variant === 'valid') {
      assert.match(page, /Dashboard browser test fixture/);
      assert.match(page, /inbox-approve/);
    } else if (variant === 'long') {
      const work = fs.readFileSync(path.join(site, 'work', 'index.html'), 'utf8');
      assert.match(work, /Page 1 of 3/);
    } else if (variant === 'empty') assert.match(page, /Nothing needs you/);
    else {
      assert.match(fs.readFileSync(path.join(root, 'team', 'state.json'), 'utf8'), /"now":/);
      assert.match(page, /dashboard could not read the supervisor state/);
    }
  }
});

// Issue #1326: the pages the browser scenario reads for the record line, built through the real view and renderer.
async function overviewOf(variant) {
  const base = tmpDir(`dashboard-e2e-${variant}-`);
  const site = path.join(base, 'site');
  fs.mkdirSync(site, { recursive: true });
  await buildFixtureSite({ root: path.join(base, 'state'), site, variant });
  return fs.readFileSync(path.join(site, 'index.html'), 'utf8');
}
const lines = page => [...page.matchAll(/<div class="hl-best sub" data-best="([a-z-]+)"[^>]*>([^<]*)<\/div>/g)].map(m => [m[1], m[2]]);

test('the record fixture shows both record lines with the stored figures and dates', async () => {
  assert.deepEqual(lines(await overviewOf('best')), [
    ['merge-rate', 'Most merged in 24 hours 106, 6 to 7 Nov'],
    ['first-pass', 'Best 24 hours 84.9% (45 of 53), 6 to 7 Nov']
  ]);
});

test('with no stored record neither card carries a record line', async () => {
  assert.deepEqual(lines(await overviewOf('best-none')), []);
});

test('a current 24 hours above the record says the record is beaten on both cards', async () => {
  const found = lines(await overviewOf('best-beaten'));
  assert.equal(found.length, 2);
  for (const [, text] of found) assert.match(text, /Record beaten/);
});
