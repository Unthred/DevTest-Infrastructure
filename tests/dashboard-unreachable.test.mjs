// Issue #432: the page shown while the dashboard is down.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../supervisor/dashui/unreachable.html', import.meta.url), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const visible = html.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');

test('page says the donkey text and makes no claim that an install is running', () => {
  assert.match(html, /The donkey's being reshod\. Back shortly\./);
  assert.match(html, /This is taking longer than an install should\./);
  // The long-wait sentence is the only place "install" may appear, and only in that fixed sentence.
  const rest = html.replace('This is taking longer than an install should.', '');
  assert.doesNotMatch(rest, /install/i);
  assert.doesNotMatch(html, /installing|upgrad|updating|in progress|being installed/i);
  assert.doesNotMatch(visible, /installing/i);
});

test('page is self-contained: no external script, style, font, image or link', () => {
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /<script[^>]*\ssrc=/i);
  assert.doesNotMatch(html, /<link[^>]*rel=["']?stylesheet/i);
  assert.doesNotMatch(html, /@import|url\(\s*["']?(?!#)/i);
  assert.doesNotMatch(html, /<img|<iframe|<form/i);
  assert.match(html, /<svg[\s\S]*aria-label="A donkey"/);
});

function run({ responses }) {
  const timers = []; let now = 1000, reloads = 0, calls = [];
  const els = { msg: { textContent: 'first' }, sub: { textContent: '' } };
  const ctx = {
    Date: { now: () => now }, document: { getElementById: id => els[id] }, location: { reload: () => { reloads++; } },
    fetch: async (url, opts) => { calls.push([url, opts]); const r = responses.shift() ?? { throws: true }; if (r.throws) throw new Error('down'); return { ok: r.ok, headers: { get: () => r.type } }; },
    setTimeout: (f, ms) => { timers.push({ f, at: now + ms }); }, setInterval: (f, ms) => { timers.push({ f, at: now + ms, every: ms }); },
  };
  vm.runInNewContext(script, ctx);
  const advance = async ms => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at); const t = timers.find(x => x.at <= end); if (!t) break;
      now = t.at; if (t.every) t.at += t.every; else timers.splice(timers.indexOf(t), 1);
      await t.f(); await new Promise(r => setImmediate(r));
    }
    now = end;
  };
  return { els, advance, calls, reloads: () => reloads };
}

test('keeps checking while the dashboard is down and does not reload', async () => {
  const p = run({ responses: [{ throws: true }, { ok: false, type: 'text/html' }, { ok: true, type: 'text/html' }] });
  await p.advance(13000);
  assert.equal(p.reloads(), 0);                       // network error, 502, and a 200 that is not JSON (a proxy page) all keep waiting
  assert.equal(p.calls.length, 3);
  assert.equal(p.calls[0][0], '/api/view.json');
  assert.equal(p.els.msg.textContent, 'first');
});

test('reloads the same URL once the dashboard answers 200 JSON', async () => {
  const p = run({ responses: [{ throws: true }, { ok: true, type: 'application/json; charset=utf-8' }] });
  await p.advance(9000);
  assert.equal(p.reloads(), 1);
});

test('after about five minutes the text changes; before that it does not', async () => {
  const p = run({ responses: Array(200).fill({ ok: false, type: 'text/plain' }) });
  await p.advance(4 * 60 * 1000 + 50000);
  assert.equal(p.els.msg.textContent, 'first');
  await p.advance(15000);
  assert.equal(p.els.msg.textContent, 'This is taking longer than an install should.');
  assert.equal(p.reloads(), 0);
});
