#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Checks the dashboard layout editor
// in a real browser at one viewport profile: drag, resize, hide and show, undo, reset, tidy, the keyboard, reload persistence, an old
// saved layout converting without moving cards, bad saved data, a refresh that fires during a drag, no horizontal page scroll, and that
// content is never cut off. Writes <name>.json to /out.
// Usage: node layout-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'layout', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => { checks.push({ name: n, ok: !!ok, detail: String(detail) }); };
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const prof = PROFILES[profile], bp = prof.viewport.width >= 1100 ? 'desktop' : prof.viewport.width >= 640 ? 'tablet' : 'phone';
const COLS = bp === 'desktop' ? 24 : 12;
const newCtx = () => browser.newContext({ ...prof, serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC', hasTouch: false, isMobile: false });
const guard = async ctx => ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
const url = p => `http://127.0.0.1:${port}${p}`;
const PAGES = [['overview', '/overview.html'], ['usage', '/usage.html'], ['reviews', '/reviews.html'], ['agents', '/agents.html']];

const geo = page => page.evaluate(() => {
  const g = document.querySelector('.cards[data-layout]'), gr = g.getBoundingClientRect(), o = {};
  for (const c of g.querySelectorAll(':scope > .card[data-card]')) { const r = c.getBoundingClientRect(); o[c.dataset.card] = { x: r.left - gr.left, y: r.top + scrollY - gr.top - scrollY, w: r.width, h: r.height, shown: r.width > 0 && getComputedStyle(c).display !== 'none' }; }
  return { cards: o, pageW: document.documentElement.scrollWidth, winW: innerWidth, pitch: (gr.width + 12) / g.__cols, gridW: gr.width };
});
const overlapAny = cards => { const v = Object.entries(cards).filter(([, r]) => r.shown); for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) { const a = v[i][1], b = v[j][1]; if (a.x + 1 < b.x + b.w && b.x + 1 < a.x + a.w && a.y + 1 < b.y + b.h && b.y + 1 < a.y + a.h) return `${v[i][0]}/${v[j][0]}`; } return ''; };
const saved = (page, p) => page.evaluate(k => JSON.parse(localStorage.getItem(k)), `dash.layout.${p}.${bp}`);
const noHScroll = async (page, label) => { const g = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: innerWidth })); check(`${label}: no horizontal page scroll`, g.s <= g.w, `${g.s}>${g.w}`); };

async function scenario(p, file) {
  const ctx = await newCtx(); await guard(ctx);
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200))); page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); }); page.on('requestfailed', r => errors.push('failed: ' + r.url().slice(-40)));
  const L = `${p}`;
  await page.goto(url(file), { waitUntil: 'networkidle' });
  await page.evaluate(n => { document.querySelector('.cards[data-layout]').__cols = n; window.__same = 1; }, COLS);
  const layoutName = await page.evaluate(() => document.querySelector('.cards[data-layout]').dataset.layout);
  const before = await geo(page); const ids = Object.keys(before.cards);
  const bar = page.locator('.layoutbar');
  check(`${L}: the Edit layout control is on the page`, await bar.locator('[data-lay=edit]').isVisible({ timeout: 3000 }), errors.join('; '));
  check(`${L}: not in layout mode the cards have no drag handles or edit chrome`, (await page.locator('.cards.editing').count()) === 0 && (await page.locator('.lay-hide').count()) === 0);
  await noHScroll(page, `${L} default`);

  // outside layout mode a drag moves nothing
  const movable = await page.evaluate(() => [...document.querySelectorAll('.cards[data-layout] > .card[data-card]')].filter(c => c.querySelector('[data-move]') && !c.hasAttribute('data-pin')).map(c => c.dataset.card));
  const pinned = await page.evaluate(() => [...document.querySelectorAll('.cards[data-layout] > .card[data-pin]')].map(c => c.dataset.card));
  const narrow = await page.evaluate(() => { const g = document.querySelector('.cards[data-layout]').getBoundingClientRect().width; return [...document.querySelectorAll('.cards[data-layout] > .card[data-card]')].filter(c => c.querySelector('[data-move]') && !c.hasAttribute('data-pin') && c.getBoundingClientRect().width < g * 0.6).map(c => c.dataset.card); });
  const first = narrow[0] || movable[0], card = id => page.locator(`#c-${id}`);
  await card(first).scrollIntoViewIfNeeded();
  let bb = await card(first).boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + 8); await page.mouse.down(); await page.mouse.move(bb.x + bb.width / 2 + 60, bb.y + 90, { steps: 6 }); await page.mouse.up();
  const noMove = await geo(page);
  check(`${L}: outside layout mode a drag does not move a card`, Math.abs(noMove.cards[first].x - before.cards[first].x) < 2 && Math.abs(noMove.cards[first].y - before.cards[first].y) < 2);
  check(`${L}: and nothing was saved`, (await saved(page, layoutName)) === null);

  // enter layout mode: nothing jumps
  await bar.locator('[data-lay=edit]').click();
  check(`${L}: layout mode shows Done, Undo, Redo, Tidy up and Reset to default`, await bar.locator('[data-lay=done]').isVisible() && await bar.locator('[data-lay=reset]').isVisible() && await bar.locator('[data-lay=tidy]').isVisible() && await bar.locator('[data-lay=undo]').isDisabled());
  const inEdit = await geo(page), pitch = inEdit.pitch;
  const jump = Math.max(...ids.filter(i => before.cards[i].shown).map(i => Math.max(Math.abs(inEdit.cards[i].x - before.cards[i].x), Math.abs(inEdit.cards[i].y - before.cards[i].y), Math.abs(inEdit.cards[i].w - before.cards[i].w))));
  check(`${L}: entering layout mode keeps every card where it was (max shift ${jump.toFixed(0)} px, grid cell ${pitch.toFixed(0)} px)`, jump <= 26, jump);
  check(`${L}: a pinned card still has Hide`, (await Promise.all(pinned.map(i => card(i).locator('.lay-hide').count()))).every(n => n === 1), pinned.join(','));
  check(`${L}: other cards do`, (await card(first).locator('.lay-hide').count()) === 1);
  check(`${L}: no overlap in layout mode`, overlapAny(inEdit.cards) === '', overlapAny(inEdit.cards));
  await page.screenshot({ path: path.join(out, `${name}-${p}-edit.png`), fullPage: false });

  // drag by the body (not a handle)
  await card(first).scrollIntoViewIfNeeded();
  bb = await card(first).boundingBox(); const g0 = (await geo(page)).cards[first];
  const sx = bb.x + bb.width / 2, sy = bb.y + bb.height / 2;
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 3, sy + 3);
  await page.mouse.move(sx + 2 * pitch, sy + 120, { steps: 8 });
  check(`${L}: while dragging a landing preview is shown`, (await page.locator('.lay-ghost').count()) === 1 && await page.locator('.lay-ghost').isVisible());
  await page.mouse.up();
  const dragged = (await geo(page));
  const d = dragged.cards[first];
  const room = dragged.gridW - (g0.x + g0.w), wantDx = Math.min(2 * pitch, Math.max(0, room));   // a card that already spans the grid cannot move sideways
  check(`${L}: dragging by the card body moved it about 2 columns (as far as there is room) and 120 px`, Math.abs((d.x - g0.x) - wantDx) <= pitch && Math.abs((d.y - g0.y) - 120) <= 30 && Math.abs(d.w - g0.w) < 2, `${(d.x - g0.x).toFixed(0)},${(d.y - g0.y).toFixed(0)} want ${wantDx.toFixed(0)}`);
  check(`${L}: no card overlaps another after the move`, overlapAny(dragged.cards) === '', overlapAny(dragged.cards));
  check(`${L}: the change is saved immediately as a free layout`, (await saved(page, layoutName))?.v === 2);
  await noHScroll(page, `${L} after drag`);
  check(`${L}: Undo is now available`, await bar.locator('[data-lay=undo]').isEnabled());

  // resize from the south-east corner and from the west edge
  await card(first).scrollIntoViewIfNeeded();
  bb = await card(first).boundingBox(); const g1 = (await geo(page)).cards[first];
  await page.mouse.move(bb.x + bb.width - 6, bb.y + bb.height - 6); await page.mouse.down(); await page.mouse.move(bb.x + bb.width + 2 * pitch, bb.y + bb.height + 60, { steps: 6 }); await page.mouse.up();
  const rs = await geo(page); const r1 = rs.cards[first];
  check(`${L}: dragging the corner makes the card wider (as far as there is room) and taller (any size, no per-type limit)`, (r1.w > g1.w + pitch || g1.x + g1.w >= rs.gridW - pitch) && r1.h > g1.h + 30 && Math.abs(r1.x - g1.x) < 2, `${g1.w.toFixed(0)}x${g1.h.toFixed(0)} -> ${r1.w.toFixed(0)}x${r1.h.toFixed(0)}`);
  check(`${L}: no overlap after the resize`, overlapAny(rs.cards) === '');
  await card(first).scrollIntoViewIfNeeded();
  bb = await card(first).boundingBox();
  await page.mouse.move(bb.x + 2, bb.y + bb.height / 2); await page.mouse.down(); await page.mouse.move(bb.x + 2 + pitch * 2, bb.y + bb.height / 2, { steps: 5 }); await page.mouse.up();
  const rw = (await geo(page)).cards[first];
  check(`${L}: dragging the west edge inward narrows it and keeps the east edge`, rw.w < r1.w - pitch && Math.abs((rw.x + rw.w) - (r1.x + r1.w)) < 2);
  // very small: content is reachable, header usable
  const sizes = [];
  for (let i = 0; i < 4; i++) {   // shrink with the corner until the card is as small as it goes
    await card(first).evaluate(c => c.scrollIntoView({ block: 'center', behavior: 'instant' }));
    bb = await card(first).boundingBox(); sizes.push(`${bb.width.toFixed(0)}x${bb.height.toFixed(0)}@${bb.x.toFixed(0)},${bb.y.toFixed(0)}`); if (bb.height < 90 && bb.width < 200) break;
    sizes.push(await page.evaluate(([x, y, first]) => { const e = document.elementFromPoint(x, y); return `at(${x.toFixed(0)},${y.toFixed(0)})=${document.elementsFromPoint(x, y).map(n => n.id || n.className || n.tagName).join(">").slice(0, 200)} card=${first}`; }, [bb.x + bb.width - 6, bb.y + bb.height - 6, first]));
    await page.mouse.move(bb.x + bb.width - 6, bb.y + bb.height - 6); await page.mouse.down(); await page.mouse.move(Math.max(bb.x + 5, 2), Math.max(bb.y + 5, 60), { steps: 8 }); await page.mouse.up();
  }
  const small = await page.evaluate(id => { const c = document.getElementById('c-' + id), r = c.getBoundingClientRect(), h = c.querySelector(':scope > header'), hr = h?.getBoundingClientRect(); return { w: r.width, h: r.height, hdr: (() => { const t = c.querySelector(':scope > header h2'); if (!t) return true; const tr = t.getBoundingClientRect(); return tr.height > 8 && tr.top >= r.top - 1 && tr.top + 16 <= r.bottom + 1; })() }; }, first);
  check(`${L}: a card can be made small (${small.w.toFixed(0)}x${small.h.toFixed(0)} px) and the start of its title stays visible`, small.h <= 100 && small.hdr, JSON.stringify(small) + ' ' + sizes.join(' '));
  await page.locator('[data-lay=done]').click();
  const reach = await page.evaluate(() => [...document.querySelectorAll('.cards.free > .card')].filter(c => c.scrollHeight > c.clientHeight + 2 && !['auto', 'scroll'].includes(getComputedStyle(c).overflowY)).map(c => c.dataset.card));
  check(`${L}: every card whose content does not fit can scroll (nothing is cut off with no way to reach it)`, reach.length === 0, reach.join(','));
  await bar.locator('[data-lay=edit]').click();

  // keyboard, undo, redo
  await card(first).focus();
  const u0 = (await geo(page)).cards[first];
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  const u1 = (await geo(page)).cards[first];
  check(`${L}: the keyboard moves a focused card (Arrow Down twice = 2 rows)`, Math.abs((u1.y - u0.y) - 48) < 3, `${(u1.y - u0.y).toFixed(1)}`);
  await page.keyboard.press('Control+z');
  const u2 = (await geo(page)).cards[first];
  check(`${L}: Ctrl+Z undoes the last change (one row back)`, Math.abs((u2.y - u0.y) - 24) < 3, `${(u2.y - u0.y).toFixed(1)}`);
  await bar.locator('[data-lay=redo]').click();
  const u3 = (await geo(page)).cards[first];
  check(`${L}: Redo restores it`, Math.abs(u3.y - u1.y) < 2);
  // keyboard
  await card(first).focus();
  const k0 = (await geo(page)).cards[first];
  await page.keyboard.press('ArrowRight');
  const k1 = (await geo(page)).cards[first];
  check(`${L}: Arrow Right moves a focused card one column`, Math.abs((k1.x - k0.x) - pitch) < 3 || (k1.x + k1.w >= (await geo(page)).pageW - 20), `${(k1.x - k0.x).toFixed(1)} vs ${pitch.toFixed(1)}`);
  await page.keyboard.press('Shift+ArrowDown');
  const k2 = (await geo(page)).cards[first];
  check(`${L}: Shift with an arrow resizes`, k2.h > k1.h + 10, `${k1.h.toFixed(0)} -> ${k2.h.toFixed(0)}`);

  // hide and show
  const hideId = narrow[1] || movable.find(i => i !== first) || first;
  await card(hideId).scrollIntoViewIfNeeded();
  await card(hideId).locator('.lay-hide').click();
  check(`${L}: Hide removes the card`, !(await card(hideId).isVisible()));
  // #851: a card that becomes pinned (a refresh in place can add data-pin) must not come back hidden from an undo/redo snapshot
  await page.evaluate(i => document.getElementById('c-' + i).setAttribute('data-pin', ''), hideId);
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+Shift+z');   // redo restores the snapshot that has it hidden
  check(`${L}: redo does not hide a card that is pinned now`, await card(hideId).isVisible() && !(await card(hideId).evaluate(c => c.classList.contains('lay-hidden'))));
  await page.evaluate(i => document.getElementById('c-' + i).removeAttribute('data-pin'), hideId);
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+Shift+z');   // an unpinned card is hidden again by the same redo
  check(`${L}: once not pinned, undo/redo hides it again`, !(await card(hideId).isVisible()));
  const onN = Number(await bar.locator('.lay-hiddens [data-n]').textContent()), totalN = Number(await bar.locator('.lay-hiddens [data-total]').textContent());
  check(`${L}: the card picker counts it as not on the page`, totalN - onN === 1, `${onN} of ${totalN}`);
  const others = await geo(page);
  check(`${L}: hiding leaves the other cards where they are`, overlapAny(others.cards) === '');
  // reload keeps position and hidden
  await page.locator('[data-lay=done]').click();
  const preReload = await geo(page);
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(n => { document.querySelector('.cards[data-layout]').__cols = n; }, COLS);
  const post = await geo(page);
  const drift = Math.max(...Object.keys(preReload.cards).filter(i => preReload.cards[i].shown).map(i => Math.max(Math.abs(post.cards[i].x - preReload.cards[i].x), Math.abs(post.cards[i].y - preReload.cards[i].y), Math.abs(post.cards[i].w - preReload.cards[i].w), Math.abs(post.cards[i].h - preReload.cards[i].h))));
  check(`${L}: after a reload every card is where it was left (max drift ${drift.toFixed(1)} px)`, drift < 2 && !post.cards[hideId].shown, drift);
  await noHScroll(page, `${L} after reload`);
  await page.screenshot({ path: path.join(out, `${name}-${p}-saved.png`), fullPage: false });
  // bring it back from the list
  check(`${L}: the card picker is available outside layout mode`, await bar.locator('.lay-hiddens').isVisible());
  await bar.locator('.lay-hiddens summary').click();
  await bar.locator('.lay-hiddens button:text-is("Add")').first().click({ timeout: 5000 });
  check(`${L}: Show brings the card back, not overlapping`, (await card(hideId).isVisible()) && overlapAny((await geo(page)).cards) === '');

  // tidy
  await bar.locator('[data-lay=edit]').click();
  await bar.locator('[data-lay=tidy]').click();
  const tidy = await geo(page);
  check(`${L}: Tidy up keeps cards apart and in their columns`, overlapAny(tidy.cards) === '');

  // controls on the right (#927)
  const rightGap = await page.evaluate(() => { const b = document.querySelector('.layoutbar').getBoundingClientRect(), e = [...document.querySelectorAll('.layoutbar > :not([hidden])')].map(n => n.getBoundingClientRect()).filter(r => r.width); return b.right - Math.max(...e.map(r => r.right)); });
  check(`${L}: the layout controls sit at the right of the bar`, rightGap < 40, rightGap);

  // groups (#927): select two cards, group them, move one, the other follows; the group survives a reload; ungroup
  const pair = (await page.evaluate(() => [...document.querySelectorAll('.cards[data-layout] > .card[data-card]')].filter(c => !c.hasAttribute('data-pin') && c.offsetParent).map(c => c.dataset.card))).slice(0, 2);
  if (pair.length === 2) {
    await card(pair[0]).scrollIntoViewIfNeeded();
    await page.keyboard.down('Shift'); await card(pair[0]).click({ position: { x: 20, y: 20 } }); await card(pair[1]).click({ position: { x: 20, y: 20 } }); await page.keyboard.up('Shift');
    check(`${L}: two selected cards enable Group`, await bar.locator('[data-lay=group]').isEnabled());
    await bar.locator('[data-lay=group]').click();
    const gsaved = await saved(page, layoutName);
    check(`${L}: the group is saved with the layout`, Array.isArray(gsaved?.groups) && gsaved.groups.some(g => pair.every(i => g.includes(i))), JSON.stringify(gsaved?.groups));
    const g1 = await geo(page); const bb0 = await card(pair[0]).boundingBox();
    await page.mouse.move(bb0.x + bb0.width / 2, bb0.y + 30); await page.mouse.down(); await page.mouse.move(bb0.x + bb0.width / 2, bb0.y + 30 + 96, { steps: 6 }); await page.mouse.up();
    const g2 = await geo(page);
    const d0 = g2.cards[pair[0]].y - g1.cards[pair[0]].y, d1 = g2.cards[pair[1]].y - g1.cards[pair[1]].y;
    check(`${L}: moving one card of a group moves the other by the same amount (${d0.toFixed(0)} / ${d1.toFixed(0)} px)`, d0 > 20 && Math.abs(d0 - d1) < 2 && overlapAny(g2.cards) === '');
    await bar.locator('[data-lay=done]').click();
    await page.reload({ waitUntil: 'networkidle' });
    await page.evaluate(n => { document.querySelector('.cards[data-layout]').__cols = n; }, COLS);
    check(`${L}: the group is still there after a reload`, (await saved(page, layoutName))?.groups?.some(g => pair.every(i => g.includes(i))));
    await bar.locator('[data-lay=edit]').click();
    check(`${L}: grouped cards are marked in layout mode`, (await page.locator('.cards.editing > .card.lay-grouped').count()) >= 2);
    // box select over the empty strip below the cards would be viewport dependent; select with shift-click and ungroup
    await card(pair[0]).scrollIntoViewIfNeeded();
    await page.keyboard.down('Shift'); await card(pair[0]).click({ position: { x: 20, y: 20 } }); await page.keyboard.up('Shift');
    check(`${L}: selecting one grouped card selects its whole group`, (await page.locator('.cards.editing > .card.lay-selected').count()) === 2);
    await bar.locator('[data-lay=ungroup]').click();
    check(`${L}: Ungroup removes the group`, ((await saved(page, layoutName))?.groups || []).length === 0);
  }

  // app bar editing (#927)
  const barItems = () => page.evaluate(() => [...document.querySelectorAll('.statusbar > [data-bar]')].filter(e => getComputedStyle(e).display !== 'none' && !['brand', 'title'].includes(e.dataset.bar)).sort((a, b) => Number(a.style.order || 0) - Number(b.style.order || 0)).map(e => e.dataset.bar));
  const bar0 = await barItems();
  if (bar0.length >= 2) {
    await page.locator('#barEdit').click();
    await page.locator('.statusbar [data-bar="' + bar0[0] + '"] .bar-ctl button').nth(1).click();
    const bar1 = await barItems();
    check(`${L}: the app bar item moves later`, bar1[1] === bar0[0], bar1.join());
    await page.locator('.statusbar [data-bar="' + bar0[0] + '"] .bar-ctl button').nth(2).click();
    check(`${L}: the app bar item can be removed`, !(await barItems()).includes(bar0[0]));
    await page.locator('.bar-picker summary').click(); await page.locator('.bar-picker button').first().click();
    check(`${L}: and added back from the picker`, (await barItems()).includes(bar0[0]));
    await page.locator('#barEdit').click();
    await page.reload({ waitUntil: 'networkidle' });
    check(`${L}: the app bar order is kept after a reload`, (await barItems()).join() === (await barItems()).join() && (await barItems()).includes(bar0[0]));
    await page.evaluate(() => localStorage.removeItem('dash.appbar'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.evaluate(n => { document.querySelector('.cards[data-layout]').__cols = n; }, COLS);
    await bar.locator('[data-lay=edit]').click();
  }

  // reset to default
  await bar.locator('[data-lay=reset]').click();
  const rst = await geo(page);
  const dev = Math.max(...ids.filter(i => before.cards[i].shown && rst.cards[i].shown).map(i => Math.max(Math.abs(rst.cards[i].x - before.cards[i].x), Math.abs(rst.cards[i].w - before.cards[i].w))));
  check(`${L}: Reset to default returns to the standard arrangement (columns within a cell)`, dev <= 26 && overlapAny(rst.cards) === '' && (await card(hideId).isVisible()), dev);
  await bar.locator('[data-lay=done]').click();
  check(`${L}: after Reset and Done nothing stays saved (the page flows by default again)`, (await saved(page, layoutName)) === null);
  check(`${L}: no script errors`, errors.length === 0, errors.join('; '));
  await ctx.close();
}

async function legacy(p, file) {
  // an old saved layout (order, spans, heights) must come out the same after the editor takes over
  const ctx = await newCtx(); await guard(ctx);
  const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  await page.goto(url(file), { waitUntil: 'load' });
  const info = await page.evaluate(() => { const g = document.querySelector('.cards[data-layout]'); return { layout: g.dataset.layout, ids: [...g.querySelectorAll(':scope > .card[data-card]')].map(c => c.dataset.card) }; });
  const old = { order: [...info.ids].reverse(), span: { [info.ids[0]]: 4, [info.ids[1]]: 8 }, h: { [info.ids[0]]: 280 }, collapsed: [] };
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [`dash.layout.${info.layout}.${bp}`, old]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(n => { document.querySelector('.cards[data-layout]').__cols = n; }, COLS);
  const flow = await geo(page);
  check(`${p}: an old saved layout still applies before the editor is used`, !(await page.locator('.cards.free').count()));
  await page.locator('[data-lay=edit]').click();
  const conv = await geo(page);
  const shift = Math.max(...info.ids.filter(i => flow.cards[i].shown).map(i => Math.max(Math.abs(conv.cards[i].x - flow.cards[i].x), Math.abs(conv.cards[i].y - flow.cards[i].y), Math.abs(conv.cards[i].w - flow.cards[i].w))));
  const order = (g) => Object.entries(g.cards).sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x).map(e => e[0]).join();
  check(`${p}: the old arrangement converts without losing it (max shift ${shift.toFixed(0)} px)`, shift <= 40 && order(flow) === order(conv), `${shift}\n${order(flow)}\n${order(conv)}`);
  await page.locator('[data-lay=done]').click();
  check(`${p}: leaving without a change keeps the old layout stored as it was`, JSON.stringify(await saved(page, info.layout)) === JSON.stringify(old));
  check(`${p}: no script errors (old layout)`, errors.length === 0, errors.join('; '));
  // bad saved data
  for (const bad of ['{broken', '[]', '{"v":2,"pos":{"x":1}}', '{"v":2,"pos":{"' + info.ids[0] + '":{"x":-5,"y":"a","w":999,"h":0.5}}}', '{"v":9}', '"x"']) {
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [`dash.layout.${info.layout}.${bp}`, bad]);
    await page.reload({ waitUntil: 'networkidle' });
    const g = await geo(page);
    check(`${p}: bad saved value ${bad.slice(0, 24)} leaves a working page`, errors.length === 0 && g.pageW <= g.winW && Object.values(g.cards).some(c => c.shown), errors.join(';'));
  }
  await ctx.close();
}

async function refreshDuringDrag(file) {
  const ctx = await newCtx(); await guard(ctx);
  const page = await ctx.newPage();
  await page.goto(url(file), { waitUntil: 'networkidle' });   // this copy refreshes every 2 s
  await page.evaluate(() => { window.__same = 1; });
  await page.locator('[data-lay=edit]').click();
  const id = await page.evaluate(() => { const g = document.querySelector('.cards[data-layout]').getBoundingClientRect().width; return [...document.querySelectorAll('.cards[data-layout] > .card[data-card]')].find(c => c.querySelector('[data-move]') && !c.hasAttribute('data-pin') && c.getBoundingClientRect().width < g * 0.6).dataset.card; });
  await page.locator(`#c-${id}`).evaluate(c => c.scrollIntoView({ block: 'start', behavior: 'instant' })); await page.evaluate(() => scrollBy(0, -100));
  const bb = await page.locator(`#c-${id}`).boundingBox(); bb.y = Math.max(bb.y, 70); bb.height = Math.min(bb.height, 200);
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await page.mouse.move(bb.x + bb.width / 2 + 40, bb.y + bb.height / 2 + 40, { steps: 4 });
  await page.waitForTimeout(4500);   // two refresh ticks pass while the button is held
  check('a refresh timer firing during a drag does not reload the page', (await page.evaluate(() => window.__same)) === 1);
  check('and the drag is still in progress', await page.locator('.lay-ghost').isVisible());
  await page.mouse.move(bb.x + bb.width / 2 + 100, bb.y + bb.height / 2 + 60, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(2600);
  check('while editing the page is not reloaded (no unsaved change can be lost)', (await page.evaluate(() => window.__same)) === 1);
  const moved = await page.evaluate(i => { const c = document.getElementById('c-' + i); return c.style.getPropertyValue('--cx') + ',' + c.style.getPropertyValue('--cy'); }, id);
  await page.locator('[data-lay=done]').click();
  await page.waitForTimeout(2800);
  check('after Done the periodic refresh resumes', (await page.evaluate(() => window.__same)) !== 1);
  await page.waitForLoadState('networkidle');
  const after = await page.evaluate(i => { const c = document.getElementById('c-' + i); return c.style.getPropertyValue('--cx') + ',' + c.style.getPropertyValue('--cy'); }, id);
  check('the layout survived the refresh', after === moved && after !== ',', `${moved} / ${after}`);
  await ctx.close();
}

// #61 / #851: the script's own in-place table update (app.js loadTable) ends with history.replaceState; drive it for real.
async function tableInPlace() {
  const ctx = await newCtx(); await guard(ctx);
  const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  // The fixture pages have no table, so serve one page of our own: the reviews fixture with a table region (the markup dashrender table() emits) before the script.
  const base = await (await ctx.request.get(url('/reviews.html'))).text();
  const tbl = '<div class="tregion" data-tregion="t1"><form class="tbar" method="get" action="/tbl.html"><input type="search" name="t1.q" aria-label="Filter"><select name="t1.size"><option>25</option></select><span data-tclear></span></form><div data-tdata><table><tbody><tr><td>row</td></tr></tbody></table></div></div>';
  const html = base.replace('<p id="tznote"', tbl + '<p id="tznote"');
  await page.route(u => new URL(u.toString()).pathname === '/tbl.html', r => r.fulfill({ status: 200, contentType: 'text/html', body: html }));   // loadTable fetches location.pathname + ?query
  await page.goto(url('/tbl.html'), { waitUntil: 'networkidle' });
  const region = page.locator('[data-tregion]').first(), tid = await region.getAttribute('data-tregion');
  await page.evaluate(() => { window.__same = 1; history.replaceState({ k: 7 }, '', location.href); });
  const before = await page.evaluate(() => location.href);
  await region.locator('input[type=search]').fill('zzz');
  await page.waitForFunction(id => location.search.includes(id + '.q=zzz'), tid, { timeout: 5000 }).catch(() => {});
  const r = await page.evaluate(() => ({ href: location.href, search: location.search, same: window.__same, state: history.state }));
  check('table: a search changes the address in place (app.js replaceState)', r.href !== before && r.search.includes(tid + '.q=zzz'), JSON.stringify(r));
  check('table: and does it without reloading the page, keeping the history state', r.same === 1 && r.state && r.state.k === 7, JSON.stringify(r));
  check('table: no script errors', errors.length === 0, errors.join(';'));
  await ctx.close();
}

async function phone() {
  const ctx = await browser.newContext({ ...PROFILES['phone-390'], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' }); await guard(ctx);
  const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  // a free layout saved for the desktop must not touch the phone
  await page.goto(url('/overview.html'), { waitUntil: 'load' });
  await page.evaluate(() => localStorage.setItem('dash.layout.overview.desktop', JSON.stringify({ v: 2, pos: { now: { x: 0, y: 0, w: 4, h: 6 } }, hidden: ['next'] })));
  await page.reload({ waitUntil: 'networkidle' });
  check('phone: no layout editor, the separate order-only layout stays', !(await page.locator('.layoutbar [data-lay=edit]').isVisible()) && (await page.locator('.cards.free').count()) === 0 && (await page.locator('#c-next').isVisible()));
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  check('phone: no horizontal page scroll', w[0] <= w[1], w.join('>'));
  check('phone: the move earlier / later buttons are available', await page.locator('[data-move]').first().isVisible());
  // behaviour-level guard for #765: a module binding named history would hide window.history in app.js
  const hist = await page.evaluate(() => ({ sr: history.scrollRestoration, fns: typeof history.replaceState === 'function' && typeof history.back === 'function' }));
  check('history: scrollRestoration is manual, so app.js still talks to window.history', hist.sr === 'manual' && hist.fns, JSON.stringify(hist));
  await page.goto(url('/overview.html?x=1'), { waitUntil: 'load' });
  const kept = await page.evaluate(() => { history.replaceState({ k: 1 }, '', location.href); return !!(history.state && history.state.k === 1); });
  check('history: replaceState on the page keeps its state', kept);
  check('phone: no script errors', errors.length === 0, errors.join(';'));
  await ctx.close();
}

try {
  for (const [p, file] of PAGES) await scenario(p, file);
  await legacy('overview', '/overview.html'); await legacy('usage', '/usage.html');
  if (bp === 'desktop') await refreshDuringDrag('/overview-fast.html'); else await refreshDuringDrag('/overview-fast.html');
  await tableInPlace();
  if (bp === 'desktop') await phone();
} catch (e) { check(`the scenario ran to the end (${String(e.stack).slice(0, 600)})`, false); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), failed: checks.filter(c => !c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ profile, ok: result.ok, passed: checks.filter(c => c.ok).length, failed: result.failed }, null, 1));
process.exit(result.ok ? 0 : 10);
