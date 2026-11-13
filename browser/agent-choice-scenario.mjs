#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Checks the Next card agent-choice reason
// (issue #1166) in a real browser: the chosen agent and deciding rule, every candidate's figures, controls inside the viewport, no script
// errors and no sideways scroll. Writes <name>.json and a screenshot to /out.
// Usage: node agent-choice-scenario.mjs --target fixture --profile <name> --page /card.html --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'agent-choice', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
let failed = true;
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${port}${arg('page') || '/card.html'}`, { waitUntil: 'networkidle' });
  const card = page.locator('[data-card="next"], #next').first();
  check('the Next card is on the page', (await card.count()) === 1);
  const why = card.locator('.sub', { hasText: 'runs implement #7' }).first();
  await why.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  check('the reason line is visible', await why.isVisible());
  const text = (await why.textContent()) || '';
  check('it names the chosen agent and the deciding rule', /^beta runs implement #7: the job costs it least of its plan relative to its spare/.test(text), text);
  check('it lists every candidate with spare, expected share, source, rate, short window room and slot', ['alpha', 'beta'].every(a => new RegExp(a + ': spare [\\d.]+%, job about [\\d.]+% of its week \\((history|default)\\), rate [\\d.]+%/h, short window room [\\d.]+%, slot free').test(text)), text);
  const box = await why.boundingBox();
  check('the reason sits inside the viewport width', box && box.x >= 0 && box.x + box.width <= PROFILES[profile].viewport.width + 1, JSON.stringify(box));
  // Scoped to the Next card: other overview panels (the frozen live-panel notices) are not part of this change.
  check('nothing in the Next card runs past the viewport', await card.evaluate(c => { const w = document.documentElement.clientWidth; return [c, ...c.querySelectorAll('*')].every(e => e.getBoundingClientRect().right <= w + 1); }));
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  failed = checks.some(c => !c.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
} catch (e) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(e.stack).slice(0, 1500) }, null, 2)); throw e; } finally { await browser.close(); }
process.exit(failed ? 1 : 0);
