// Refresh in place (issue #930). The page used to reload itself completely every minute, which redrew everything and lost the
// viewer's place. This fetches the same address, compares each card's content with what the previous fetch returned, and swaps only the
// cards (and status-bar figures) whose content changed. A swapped card keeps its place, its layout, its header and the viewer's state:
// inner scroll, open details, typed text, focus. Nothing is swapped while the viewer is interacting; the update is applied straight after.
// Progressive enhancement: without script the <noscript> meta refresh still reloads the page.

// ---- pure logic (unit tested without a DOM)

// Classes the page's own script puts on a card; they are not part of what the server sent and must never be synced.
export const SCRIPT_CLASS = /^(collapsed|expanded|measuring|lay-.*|editing|free)$/;
export const serverClasses = cls => [...new Set(String(cls || '').split(/\s+/).filter(c => c && !SCRIPT_CLASS.test(c)))].sort();

// prev and next are Map<key, signature>. Returns what to change; unchanged keys are absent.
export function diffRegions(prev, next) {
  const changed = [], added = [], removed = [];
  for (const [k, sig] of next) { if (!prev.has(k)) added.push(k); else if (prev.get(k) !== sig) changed.push(k); }
  for (const k of prev.keys()) if (!next.has(k)) removed.push(k);
  return { changed, added, removed, any: changed.length + added.length + removed.length > 0 };
}

// Why an update must wait, or null. `s` is a plain snapshot so the rule is testable.
// manual: the viewer asked for the refresh, so typing or a selection does not hold it; a dialog, a drag or the layout editor still do.
export const TYPING_HOLD_MS = 8000;
export function busyReason(s, { manual = false } = {}) {
  if (s.layoutEditing) return 'layout editing';
  if (s.barEditing) return 'app bar editing';
  if (s.dragging) return 'dragging';
  if (s.dialogOpen) return 'dialog open';
  if (s.expanded) return 'card expanded';
  if (s.menuOpen) return 'menu open';
  if (manual) return null;
  if (s.fieldFocused && s.sinceKey != null && s.sinceKey < TYPING_HOLD_MS) return 'typing';
  if (s.selecting) return 'text selected';
  return null;
}

export const stamp = d => [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');

// ---- DOM side

const OWN_SCRIPT = '[data-procs], [data-watch]';   // cards whose own script polls and renders them
const KEEP = 'header, .resize, [class^="lay-"]';   // direct children of a card that belong to the page's script, not to the server's body
const regionKey = el => `c:${el.dataset.card}`;

// Signature of a card is its content, not its root attributes: the layout scripts add classes and styles to the root.
export function readRegions(root) {
  const out = new Map();
  for (const el of root.querySelectorAll('.card[data-card]')) {
    if (el.querySelector(OWN_SCRIPT)) continue;
    out.set(regionKey(el), { el, sig: el.innerHTML, rows: rowMap(el, li => li.outerHTML), classes: serverClasses(el.className), href: el.getAttribute('href') });
  }
  const stats = [...root.querySelectorAll('.statusbar .stat')];
  out.set('stats', { els: stats, sig: stats.map(s => s.outerHTML).join(''), classes: [] });
  return out;
}
const sigs = regions => new Map([...regions].map(([k, v]) => [k, v.sig]));

// A way to find "the same element" again after its card's body was rebuilt: by id, else by its row key, else by position.
function locate(root, el) {
  if (el === root) return { self: true };
  if (el.id) return { id: el.id };
  const row = el.closest('[data-key]');
  if (row && root.contains(row)) {
    const same = [...row.querySelectorAll(el.tagName)];
    return { key: row.dataset.key, tag: el.tagName, n: row === el ? 0 : same.indexOf(el) };
  }
  const path = []; let n = el;
  while (n && n !== root) { path.unshift([...n.parentElement.children].indexOf(n)); n = n.parentElement; }
  return { path, tag: el.tagName };
}
function find(root, loc) {
  if (loc.self) return root;
  if (loc.id) return root.ownerDocument.getElementById(loc.id);
  if (loc.key !== undefined) {
    const row = [...root.querySelectorAll('[data-key]')].find(r => r.dataset.key === loc.key);
    if (!row) return null;
    if (row.tagName === loc.tag && loc.n === 0 && !row.querySelector(loc.tag)) return row;
    return [...row.querySelectorAll(loc.tag)][loc.n] || null;
  }
  let n = root;
  for (const i of loc.path) { n = n?.children[i]; if (!n) return null; }
  return n && n.tagName === loc.tag ? n : null;
}
const inList = el => !!el.closest('.dlist, [data-tregion]');   // those keep their own state (lists-ui.mjs, the table address)

export function capture(card, doc) {
  const snap = { scroll: [], open: [], fields: [], focus: null };
  for (const el of [card, ...card.querySelectorAll('*')]) {
    if ((el.scrollTop > 0 || el.scrollLeft > 0) && !(el !== card && inList(el))) snap.scroll.push({ loc: locate(card, el), top: el.scrollTop, left: el.scrollLeft });
  }
  for (const d of card.querySelectorAll('details[open]')) if (!inList(d)) snap.open.push(locate(card, d));
  for (const f of card.querySelectorAll('input, textarea, select')) {
    if (inList(f) || f.type === 'hidden' || f.type === 'submit' || f.type === 'button') continue;
    snap.fields.push({ loc: locate(card, f), value: f.value, checked: f.checked });
  }
  const a = doc.activeElement;
  if (a && a !== doc.body && card.contains(a)) snap.focus = { loc: locate(card, a), start: a.selectionStart ?? null, end: a.selectionEnd ?? null };
  return snap;
}
export function restore(card, snap) {
  for (const o of snap.open) { const d = find(card, o); if (d && d.tagName === 'DETAILS') d.open = true; }
  for (const f of snap.fields) {
    const el = find(card, f.loc); if (!el) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = f.checked; else el.value = f.value;
  }
  for (const s of snap.scroll) { const el = find(card, s.loc); if (el) { el.scrollTop = s.top; el.scrollLeft = s.left; } }
  if (snap.focus) {
    const el = find(card, snap.focus.loc);
    if (el && typeof el.focus === 'function') {
      el.focus({ preventScroll: true });
      if (snap.focus.start != null && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(snap.focus.start, snap.focus.end); } catch { /* not a text field */ } }
    }
  }
}

// Keyed rows (issue #930, requirement 2): every list row carries the item's id (data-key). A row whose server content is the same as in the
// previous fetch is moved into the fresh list as the very element the viewer has, with its open details, focus and inner scroll; only a new
// or changed row is taken from the fresh page, and a vanished row is dropped with the old list. The list is then initialised again by the
// page's list script (lists-ui.mjs), which re-reads its search, sort and scroll.
const rowMap = (card, pick) => { const m = new Map(); for (const list of card.querySelectorAll('[data-dlist]')) for (const li of list.querySelectorAll(':scope > .dl-scroll > li[data-key]')) m.set(`${list.dataset.dlist}|${li.dataset.key}`, pick(li)); return m; };
export function retainRows(nodes, liveRows, prevSigs) {
  let kept = 0;
  for (const n of nodes) {
    if (n.nodeType !== 1) continue;
    for (const list of n.matches('[data-dlist]') ? [n] : n.querySelectorAll('[data-dlist]')) {
      for (const li of list.querySelectorAll(':scope > .dl-scroll > li[data-key]')) {
        const id = `${list.dataset.dlist}|${li.dataset.key}`, old = liveRows.get(id);
        if (old && prevSigs.get(id) === li.outerHTML) { li.replaceWith(old); kept++; }
      }
    }
  }
  return kept;
}

function swapCard(live, fresh, doc, hooks, prevRows) {
  const snap = capture(live, doc);
  hooks.beforeSwap?.(live);
  const head = fresh.querySelector(':scope > header h2'), liveHead = live.querySelector(':scope > header h2');
  if (head && liveHead && liveHead.textContent !== head.textContent) liveHead.textContent = head.textContent;
  const nodes = [...fresh.children].filter(c => !c.matches('header')).map(c => doc.importNode(c, true));
  if (prevRows) retainRows(nodes, rowMap(live, li => li), prevRows);
  for (const c of [...live.children]) if (!c.matches(KEEP)) c.remove();
  for (const c of nodes) live.append(c);
  restore(live, snap);
  hooks.afterSwap?.(live);
}
function syncClasses(live, prev, next) {
  for (const c of prev) if (!next.includes(c)) live.classList.remove(c);
  for (const c of next) if (!prev.includes(c)) live.classList.add(c);
}

// Apply fresh regions to the live page. Returns the number of regions changed. `known` is the Map of what the previous fetch held.
// A status-bar item the viewer opened (an agent item's detail, issue #1221) stays open, and keeps focus, when its text is refreshed.
function replaceStat(doc, el, fresh) {
  const wasOpen = el.querySelector('details[open]') !== null, hadFocus = el.contains(doc.activeElement);
  const node = doc.importNode(fresh, true);
  el.replaceWith(node);
  if (wasOpen) node.querySelectorAll('details').forEach(d => { d.open = true; });
  if (hadFocus) node.querySelector('summary')?.focus({ preventScroll: true });
}

export function applyFresh({ doc, fresh, known, hooks = {} }) {
  const live = readRegions(doc), diff = diffRegions(sigs(known), sigs(fresh));
  const y = doc.defaultView?.scrollY ?? 0, x = doc.defaultView?.scrollX ?? 0;
  let n = 0;
  for (const k of diff.changed) {
    if (k === 'stats') {
      const nowEls = live.get('stats').els, newEls = fresh.get('stats').els;
      if (nowEls.length === newEls.length) nowEls.forEach((el, i) => { if (el.outerHTML !== newEls[i].outerHTML) replaceStat(doc, el, newEls[i]); });
      else { const anchor = nowEls[0]; for (const e of newEls) anchor?.before(doc.importNode(e, true)); for (const e of nowEls) e.remove(); }
      hooks.afterStats?.(); n++; continue;
    }
    const el = live.get(k)?.el, f = fresh.get(k);
    if (!el || !f) continue;
    swapCard(el, f.el, doc, hooks, known.get(k)?.rows);
    syncClasses(el, known.get(k).classes, f.classes);
    if (f.href != null && el.getAttribute('href') !== f.href) el.setAttribute('href', f.href);
    n++;
  }
  // Added or removed cards (a new item appeared or finished): insert after the preceding fresh card, drop the vanished.
  for (const k of diff.removed) { if (k !== 'stats') live.get(k)?.el.remove(); n++; }
  for (const k of diff.added) {
    const f = fresh.get(k); if (!f?.el) continue;
    const order = [...fresh.keys()].filter(x => x.startsWith('c:')), prevKey = order[order.indexOf(k) - 1];
    const after = prevKey ? readRegions(doc).get(prevKey)?.el : null, parent = after?.parentElement || doc.querySelector('.cards[data-layout]');
    const node = doc.importNode(f.el, true);
    if (after) after.after(node); else parent?.prepend(node);
    hooks.afterSwap?.(node); n++;
  }
  if (doc.defaultView && (doc.defaultView.scrollY !== y || doc.defaultView.scrollX !== x)) doc.defaultView.scrollTo(x, y);
  return n;
}

// Everything the page needs once: the baseline (what the server sent), the indicator, the timer. `env` carries the browser.
export function startRefresh(env) {
  const { document: doc, seconds = 60, hooks = {}, fetchFn = (...a) => fetch(...a), setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, now = () => new Date(), isBusy } = env;
  const bar = doc.querySelector('.statusbar');
  if (!bar) return null;   // a page without the status bar (the unreachable page, a bare fragment) has nothing to keep fresh
  let known = env.baseline || readRegions(doc), pending = null, againLive = false, pendingLive = false, inflight = false, waitTimer = 0, lastKey = null, lastAt = Date.now(), failures = 0, pointerDown = false;
  const anchor = doc.querySelector('#theme');
  const box = doc.createElement('span'); box.className = 'refresh-box';
  const label = doc.createElement('span'); label.className = 'refresh-at'; label.dataset.refreshAt = ''; label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'off');
  const btn = doc.createElement('button'); btn.type = 'button'; btn.className = 'btn refresh-now'; btn.textContent = 'Refresh'; btn.title = 'Refresh the figures now'; btn.setAttribute('aria-label', 'Refresh now');
  box.append(label, btn);
  if (bar) bar.insertBefore(box, anchor && anchor.parentElement === bar ? anchor : null);
  const show = text => { label.textContent = text; };
  show(`Updated ${stamp(now())}`);

  doc.addEventListener('keydown', e => { if (e.target?.matches?.('input, textarea, select, [contenteditable]')) lastKey = Date.now(); }, true);
  doc.addEventListener('pointerdown', () => { pointerDown = true; }, true);
  for (const t of ['pointerup', 'pointercancel', 'dragend']) doc.addEventListener(t, () => { pointerDown = false; }, true);
  const snapshot = () => {
    const a = doc.activeElement, sel = doc.getSelection?.() || doc.defaultView?.getSelection?.();
    return {
      layoutEditing: doc.body.classList.contains('layout-editing'), barEditing: !!doc.querySelector('.statusbar.bar-editing'), dragging: pointerDown && !!doc.querySelector('.lay-active, .dock-zones, .sb-thumb.drag'),
      dialogOpen: !!doc.querySelector('dialog[open], .copy-manual, [role=dialog]:not([hidden])'), expanded: !!doc.querySelector('.card.expanded'),
      menuOpen: !!doc.querySelector('[aria-haspopup][aria-expanded=true]'),
      fieldFocused: !!a && a.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable]'), sinceKey: lastKey == null ? null : Date.now() - lastKey,
      selecting: !!sel && !sel.isCollapsed && String(sel).length > 0
    };
  };
  const busy = manual => (isBusy ? isBusy(manual) : busyReason(snapshot(), { manual }));

  const flush = manual => {
    clearTimer(waitTimer); waitTimer = 0;
    if (!pending) return;
    if (busy(manual)) { waitTimer = setTimer(() => flush(false), 500); return; }   // apply straight after the interaction ends
    const fresh = pending, from = pendingLive ? readRegions(doc) : known; pending = null; pendingLive = false;
    try { applyFresh({ doc, fresh, known: from, hooks }); known = fresh; show(`Updated ${stamp(now())}`); lastAt = Date.now(); }
    catch { show(`Update failed ${stamp(now())}`); }
  };
  // live: compare the fresh page with the page as it is now, not with the previous fetch. The page's own script changes cards between
  // fetches (an Inbox decision, its Undo), so the previous fetch no longer describes what is on screen.
  async function refresh(manual = false, { live = false } = {}) {
    if (inflight) { if (live) againLive = true; return; } inflight = true;
    if (manual) show('Updating…');
    try {
      const r = await fetchFn(doc.defaultView.location.href, { headers: { accept: 'text/html' }, credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok || !/html/.test(r.headers?.get?.('content-type') || 'text/html')) throw new Error(`HTTP ${r.status}`);
      const parsed = new doc.defaultView.DOMParser().parseFromString(await r.text(), 'text/html');
      if (!parsed.querySelector('.cards')) throw new Error('not a dashboard page');
      pending = readRegions(parsed); pendingLive = pendingLive || live; failures = 0;
      flush(manual);
      if (manual && !pending) lastAt = Date.now();
    } catch {
      failures++; show(`Update failed ${stamp(now())}${failures > 1 ? ', still trying' : ''}`);
    } finally { inflight = false; if (againLive) { againLive = false; refresh(true, { live: true }); } }
  }
  btn.addEventListener('click', () => refresh(true));
  setRepeat(() => { if (!doc.hidden) refresh(false); }, seconds * 1000);
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden && Date.now() - lastAt > seconds * 1000) refresh(false); });
  return { refresh, flush, get known() { return known; } };
}
