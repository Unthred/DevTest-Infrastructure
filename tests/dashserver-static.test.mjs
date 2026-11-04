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

test('every /static/ asset referenced by the dashboard source or dashui files is routed', () => {
  const dir = new URL('../supervisor/dashui/', import.meta.url);
  const sources = ['dashserver.mjs', 'dashrender.mjs'].map(f => fs.readFileSync(new URL(`../supervisor/${f}`, import.meta.url), 'utf8'));
  for (const f of fs.readdirSync(dir)) if (/\.(html|js|mjs|css)$/.test(f)) sources.push(fs.readFileSync(new URL(f, dir), 'utf8'));
  const linked = new Set(sources.flatMap(s => [...s.matchAll(/\/static\/[\w.-]+/g)].map(m => m[0])));
  // dashrender.mjs emits the page links, so the scan must find them there.
  for (const r of ['/static/style.css', '/static/early.js', '/static/app.js', '/static/watch.js']) assert.ok(linked.has(r), `${r} not found by the scan`);
  assert.deepEqual([...linked].filter(r => !STATIC[r]), []);
});
