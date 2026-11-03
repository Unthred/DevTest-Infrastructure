import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STATIC } from '../supervisor/dashserver.mjs';

// Issue #447: the page smoke stages dashui files from STATIC, so STATIC must name real files and cover every asset a page links.
test('every STATIC route maps to an existing dashui file with a content type', () => {
  assert.ok(Object.keys(STATIC).length >= 5);
  for (const [route, [file, type]] of Object.entries(STATIC)) {
    assert.match(route, /^\/static\//);
    assert.ok(fs.existsSync(new URL(`../supervisor/dashui/${file}`, import.meta.url)), `${file} missing`);
    assert.match(type, /^(text\/css|text\/javascript);/);
  }
});

test('a static asset that is not routed is detected (negative case)', () => {
  const html = '<script src="/static/new-asset.js"></script><link href="/static/style.css">';
  const linked = [...html.matchAll(/\/static\/[\w.-]+/g)].map(m => m[0]);
  assert.deepEqual(linked.filter(r => !STATIC[r]), ['/static/new-asset.js']);
});
