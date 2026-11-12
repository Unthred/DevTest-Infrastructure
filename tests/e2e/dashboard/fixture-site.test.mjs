import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from '../../helpers/tmp.mjs';
import { buildFixtureSite } from './fixture-site.mjs';

test('dashboard e2e fixture pages cover valid, empty and malformed state', async () => {
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
      assert.match(page, /Fixture state unavailable/);
      assert.match(page, /Fixture JSON is malformed/);
    }
  }
});
