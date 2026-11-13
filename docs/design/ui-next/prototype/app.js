// Foreman ui-next prototype: one client of the v1 contract. It reads only /api/v1/* (the mock core), sends named commands,
// and listens to the event stream. All formatting (time zone, pounds, percentages, labels, colours) happens here, not in the core.
const API = '/api/v1', TZ = 'Europe/London';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attr = v => esc(JSON.stringify(v));

// ---------- formatting (client side by contract)
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtTime = iso => (iso ? timeFmt.format(new Date(iso)) : 'unknown');
const fmtDur = s => { if (s == null) return 'unknown'; const m = Math.floor(s / 60); return m < 1 ? `${s}s` : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`; };
const fmtTok = n => (n == null ? 'unknown' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const fmtGbp = p => (p == null ? 'unknown' : `£${(p / 100).toFixed(2)}`);
const pct = f => (f == null ? '?' : `${Math.round(f * 100)}%`);
const words = s => { const t = String(s || 'unknown').replace(/_/g, ' '); return t[0].toUpperCase() + t.slice(1); };
const LABEL = { 'inbox.approve': 'Approve', 'inbox.reject': 'Reject', 'inbox.park': 'Park', 'inbox.unpark': 'Unpark', 'inbox.requeue': 'Requeue', 'inbox.dismiss': 'Dismiss', 'inbox.undo_decision': 'Undo',
  'work_item.park': 'Park', 'work_item.unpark': 'Unpark', 'work_item.set_rank': 'Change rank', 'work_item.edit_prerequisites': 'Fix prerequisites', 'work_item.assign': 'Assign', 'work_item.fix_description': 'Fix the description',
  'work_item.accept_split': 'Accept split', 'work_item.allow_fix_round': 'Allow one more fix round', 'work_item.clear_retry_cap': 'Clear retry cap', 'job.start': 'Start now', 'job.resume': 'Resume', 'job.stop': 'Stop', 'job.close': 'Close job',
  'agent.refresh_allowance': 'Refresh reading', 'agent.pause': 'Pause agent', 'agent.resume': 'Resume agent', 'decision.approve': 'Approve decision', 'decision.reject': 'Reject decision', 'homeowner_step.mark_done': 'Mark done', 'audit.undo': 'Undo' };
const label = a => { const base = LABEL[a.command] || words(a.command.split('.')[1]); return a.command === 'job.start' && a.input.target ? `Start ${a.input.type || 'job'} on ${refLabel(a.input.target)}` : base; };
const refLabel = key => String(key).replace(/^change-/, 'PR #').replace(/^issue-/, '#');

// ---------- state
const saved = (() => { try { return JSON.parse(localStorage.getItem('foreman.ui') || '{}'); } catch { return {}; } })();
const S = {
  m: {}, detail: {}, route: { screen: 'overview' }, panel: null, live: { state: 'connecting', beat: Date.now() },
  ui: { theme: saved.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), density: saved.density || 'comfortable',
    inbox: { view: 'cards', state: ['waiting_for_approval'], kind: [], q: '', sort: 'newest', group: 'none', shown: 60, filters: 'closed', ...(saved.inbox || {}) },
    queue: { view: 'table', filter: 'all', q: '', stage: null, ...(saved.queue || {}) }, jobs: { filter: 'all', kind: null, cause: null, q: '' }, audit: { filter: 'all' }, views: saved.views || [] },
  sel: new Set(), group: {}
};
const persist = () => { try { localStorage.setItem('foreman.ui', JSON.stringify({ theme: S.ui.theme, density: S.ui.density, inbox: { view: S.ui.inbox.view, sort: S.ui.inbox.sort, group: S.ui.inbox.group }, queue: { view: S.ui.queue.view }, views: S.ui.views })); } catch { /* storage is a convenience only */ } };

// ---------- the contract client
async function api(path) { const r = await fetch(API + path, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); }
async function load(names) {
  await Promise.all(names.map(async n => { try { S.m[n] = await api(n === 'inbox' ? '/inbox?limit=500' : `/${n}`); } catch (e) { S.m[n] = S.m[n] || null; S.error = String(e.message); } }));
  if (S.m.meta) S.group = Object.fromEntries(S.m.meta.data.states.map(s => [s.state, s.group]));
}
async function send(command, input, reason) {
  const body = { input, reason: reason || null, idempotency_key: crypto.randomUUID().replace(/-/g, '') };
  try { const r = await fetch(`${API}/commands/${command}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }); return await r.json(); }
  catch (e) { return { ok: false, command, outcome: 'refused', refusal_code: 'unreachable', refusal_text: 'Foreman could not be reached; nothing was changed.' }; }
}

// ---------- the status language: one mapping from a condition to shape, word and tone
const toneOf = c => (c.attention === 'fault' ? 'fault' : c.attention === 'homeowner' ? 'you' : c.attention === 'unknown' ? 'unknown' : ({ failed: 'fault', unknown: 'unknown' }[S.group[c.state]] || S.group[c.state] || 'waiting'));
const status = (c, text) => { const t = toneOf(c); return `<span class="st t-${t}"><i class="dot t-${t}" aria-hidden="true"></i><span class="w">${esc(text || words(c.state))}</span></span>`; };
const idChip = id => `<button class="id" data-copy="${esc(id)}" title="Copy ${esc(id)}">${esc(id)}</button>`;
const actionBtns = (actions, small) => (actions || []).map(a => `<span><button class="btn${a.primary ? ' primary' : ''}${small ? ' small' : ''}" data-cmd="${attr(a)}"${a.enabled ? '' : ' disabled'}>${esc(label(a))}</button>${a.enabled ? '' : `<div class="why-not">${esc(a.refusal_text || 'Not available now')}</div>`}</span>`).join('');
const chip = (text, count, on, data) => `<button class="chip" aria-pressed="${on}" ${data}>${esc(text)}${count == null ? '' : ` <span class="count">${count}</span>`}</button>`;
const listHref = l => `#/${l.model}?${new URLSearchParams(l.filter)}`;

// ---------- app bar: one line
function renderAppbar() {
  const a = S.m.appbar; if (!a) { $('appbar').innerHTML = '<span class="brand">Foreman</span><span class="st t-unknown"><i class="dot t-unknown"></i><span class="w">No data</span></span>'; return; }
  const d = a.data, sys = d.system;
  const agent = g => { const stale = g.reading.stale, w = g.weekly, s = g.short;
    const fig = x => (x.state === 'known' ? `<b class="${stale ? 'stale-mark' : ''}">${pct(x.used_fraction)}</b>` : '<b class="stale-mark" title="unknown">?</b>');
    return `<button class="chip agent" data-pop="${esc(g.id)}" aria-label="${esc(g.display_name)}: ${esc(words(g.condition.state))}, weekly ${w.state === 'known' ? pct(w.used_fraction) : 'unknown'}, 5 hour ${s.state === 'known' ? pct(s.used_fraction) : 'unknown'}${stale ? ', reading stale' : ''}"><i class="dot t-${toneOf(g.condition)}"></i>${esc(g.display_name)} ${fig(w)}<span class="muted">·</span>${fig(s)}${stale ? `<span class="stale-mark small">${fmtDur(g.reading.age_seconds).split(' ')[0]}<span class="wide"> old</span></span>` : ''}</button>`; };
  const live = { live: ['active', 'Live'], connecting: ['waiting', 'Connecting'], reconnecting: ['unknown', 'Reconnecting'], behind: ['unknown', 'Behind'] }[S.live.state];
  $('appbar').innerHTML = `<span class="brand">Foreman</span>
    <a class="chip" href="#/overview" title="${esc(sys.reason_text || '')}">${status(sys)}${sys.since && sys.attention !== 'none' ? `<span class="wide">${fmtDur(Math.round((Date.parse(a.generated_at) - Date.parse(sys.since)) / 1000))}</span>` : ''}</a>
    ${d.agents.map(agent).join('')}
    <span class="wide muted small">slots ${d.slots.in_use}/${d.slots.max} · tick ${esc(d.tick.state)}${d.tick.next_at ? ` ${fmtTime(d.tick.next_at).slice(-5)}` : ''}</span>
    <span class="spacer"></span>
    <span class="st t-${live[0]} small" title="Event stream"><i class="dot t-${live[0]}"></i><span class="w wide">${live[1]}</span></span>
    <button class="chip wide" data-ui="theme" title="Theme">${S.ui.theme === 'dark' ? 'Light' : 'Dark'}</button>
    <button class="chip wide" data-ui="density" title="Density">${S.ui.density === 'compact' ? 'Comfortable' : 'Compact'}</button>`;
}
function renderNav() {
  const c = S.m.appbar?.data.counts || {}, cur = S.route.screen;
  const link = (id, text, badge = '') => `<a href="#/${id}" ${cur === id ? 'aria-current="page"' : ''}><span>${text}</span>${badge}</a>`;
  $('nav').innerHTML = link('overview', 'Overview', (c.needs_you ? `<span class="badge you" title="Needs you">${c.needs_you}</span>` : '') ) + link('queue', 'Queue', c.planned_held ? `<span class="badge">${c.planned_held} held</span>` : '')
    + link('inbox', 'Inbox', c.inbox_waiting ? `<span class="badge you">${c.inbox_waiting}</span>` : '') + link('jobs', 'Jobs', `<span class="badge">${c.running_jobs ?? 0}</span>`) + link('allowance', 'Allowance') + link('audit', 'Audit')
    + `<div class="foot small muted"><span>Contract ${esc(S.m.meta?.data.contract || '?')}</span><span>Core ${esc(S.m.meta?.data.core_version || '?')}</span><span>Times: ${TZ}</span></div>`;
}
// The stalled banner and the stale banner live outside the screens, so they show on every screen.
function renderBanner() {
  const o = S.m.overview, a = S.m.appbar; let html = '';
  if (a && a.freshness.state !== 'fresh') html += `<div class="banner unknown">${status({ state: 'stale', attention: 'unknown' }, 'Data is stale')} Last tick ${fmtTime(a.freshness.tick_at)} (${fmtDur(a.freshness.age_seconds)} ago). ${esc(a.freshness.reason_text || '')} Figures below may be out of date.</div>`;
  if (S.live.state === 'behind') html += '<div class="banner unknown">The live connection is behind. Showing the last data received; retrying.</div>';
  if (o && o.data.stalls.length) {
    const v = o.data.verdict;
    html += `<div class="banner fault" id="stalled"><div class="row"><strong>${status(v, 'Stalled: nothing is running')}</strong><span>${esc(v.reason_text)}</span>${S.route.screen === 'overview' ? '' : '<a href="#/overview">See why</a>'}</div>
      ${S.route.screen === 'overview' ? `<div class="stall">${o.data.stalls.map(s => `<div class="card ${toneOf(s.condition)}"><h3>${esc(s.agent)} idle for ${fmtDur(s.idle_seconds)}</h3>
        <div>${status(s.condition, s.condition.reason_code === 'unrecorded' ? 'No reason recorded' : words(s.condition.reason_code))} <span class="reason">${esc(s.condition.reason_text)}</span></div>
        ${s.planned.map(p => `<div class="item"><button class="link" data-open="work:${esc(p.target.key)}">${esc(words(p.type))} ${esc(p.target.label)}</button> <span class="reason">${esc(p.condition.reason_text)}${p.held_by ? ` Held by ${esc(p.held_by.label)}.` : ''}</span></div>`).join('')}
        <div class="actions">${actionBtns(s.actions)}</div></div>`).join('')}</div>` : ''}</div>`;
  }
  $('banner').innerHTML = html;
}

// ---------- screens
function attentionList(items, tone, emptyText) {
  if (!items.length) return `<div class="empty">${emptyText}</div>`;
  return items.map(i => `<div class="item"><div class="row"><span class="title">${esc(i.title)}</span>${i.count > 1 ? `<span class="badge ${tone}">${i.count}</span>` : ''}</div>
    <div>${status(i.condition, words(i.condition.reason_code || i.condition.state))} <span class="reason">${esc(i.condition.reason_text)}</span></div>
    ${i.step_text ? `<div><b>Your step:</b> ${esc(i.step_text)}</div>` : ''}
    <div class="actions">${i.list ? `<a class="btn primary" href="${listHref(i.list)}" style="display:inline-flex;align-items:center;text-decoration:none">Open the ${i.count > 1 ? i.count + ' ' : ''}${esc(i.list.model)} items</a>` : ''}${actionBtns(i.actions)}${i.target && i.target.kind !== 'decision' && i.target.kind !== 'agent' ? `<button class="btn ghost" data-open="${i.target.kind === 'job' ? 'job' : 'work'}:${esc(i.target.key)}">Details</button>` : ''}</div></div>`).join('');
}
function overview() {
  const d = S.m.overview.data, h = d.headline, w = d.waste;
  return `<h1>Overview</h1><div class="grid cols-2">
    <section class="card you"><h2>Needs you (${d.needs_you.length})</h2>${attentionList(d.needs_you, 'you', 'Nothing waits for you.')}</section>
    <section class="card fault"><h2>Faults (${d.faults.length})</h2>${attentionList(d.faults, 'fault', 'No faults.')}</section></div>
    <div class="grid cols-4" style="margin-top:var(--gap)">
      <a class="card stat" href="#/jobs"><h2>Slots</h2><div class="slots">${Array.from({ length: d.slots.max }, (_, i) => `<i class="slot ${i < d.slots.in_use ? 'used' : d.stalls.length ? 'idle-fault' : ''}"></i>`).join('')}</div><div class="muted">${d.slots.in_use} of ${d.slots.max} in use</div></a>
      <a class="card stat" href="#/queue?filter=changes"><h2>First pass approval, 24 h</h2><div class="v">${h.first_pass.fraction == null ? 'unknown' : (h.first_pass.fraction * 100).toFixed(1) + '%'}</div><div class="muted">${h.first_pass.approved} of ${h.first_pass.reviewed} reviews</div></a>
      <a class="card stat" href="#/queue"><h2>Merges, 24 h</h2><div class="v">${h.merges}</div><div class="muted">merged changes</div></a>
      <a class="card stat" href="#/jobs?kind=rebase${w.top_cause ? `&cause=${esc(w.top_cause.code)}` : ''}"><h2>Waste, 7 days</h2><div class="v">${fmtTok(w.tokens)}</div><div class="muted">${w.jobs} jobs${w.top_cause ? `; ${pct(w.top_cause.fraction)} from "${esc(w.top_cause.text)}" across ${w.top_cause.changes} PRs` : ''}</div></a></div>
    <div class="grid cols-2" style="margin-top:var(--gap)">
      <section class="card"><h2>Planned next (${d.planned.length})</h2>${d.planned.map(p => `<div class="item"><div class="row"><button class="link" data-open="work:${esc(p.target.key)}">${esc(words(p.type))} ${esc(p.target.label)}</button><span class="muted">${esc(p.agent || 'unassigned')}</span>${status(p.condition, p.condition.reason_code === 'unrecorded' ? 'Held, no reason recorded' : words(p.condition.state))}</div><div class="reason">${esc(p.target.title || '')}${p.held_by ? ` · held by ${esc(p.held_by.label)}` : ''}</div></div>`).join('') || '<div class="empty">Nothing planned.</div>'}</section>
      <section class="card"><h2>Pipeline</h2><div class="row">${d.pipeline.map(p => `<a class="chip" href="#/queue?stage=${esc(p.stage)}">${esc(words(p.stage))} <span class="count">${p.count}</span></a>`).join('')}</div>
        <h2 style="margin-top:var(--gap)">Host</h2>${status(d.host)}</section></div>`;
}

const QF = { all: () => true, held: i => i.condition.state === 'held', you: i => i.condition.attention === 'homeowner', faults: i => i.condition.attention === 'fault', parked: i => i.stage === 'parked', changes: i => i.type === 'change', issues: i => i.type === 'issue' };
function queue() {
  const d = S.m.queue.data, u = S.ui.queue, q = u.q.toLowerCase();
  const base = d.items.filter(i => (!u.stage || i.stage === u.stage) && (!q || `${i.number} ${i.title}`.toLowerCase().includes(q)));
  const items = base.filter(QF[u.filter] || QF.all).sort((a, b) => (a.type === b.type ? (a.rank ?? 999) - (b.rank ?? 999) : a.type === 'change' ? -1 : 1));
  const names = { all: 'All', you: 'Needs you', faults: 'Faults', held: 'Held', parked: 'Parked', changes: 'Changes', issues: 'Issues' };
  const rounds = c => (c ? `R${c.review_rounds} · F${c.fix_rounds}/${c.fix_limit ?? '?'} · Rb${c.rebase_attempts}` : '');
  const pre = p => (p.line_state === 'malformed' ? '<span class="st t-fault"><i class="dot t-fault"></i><span class="w">Malformed</span></span>' : p.declared.length ? p.declared.map(n => `#${n}${p.open.includes(n) ? ' (open)' : ''}`).join(', ') : '');
  const table = `<div class="tablewrap"><table><thead><tr><th>Rank</th><th>Item</th><th>Stage</th><th>State and reason</th><th class="hide-s">Agent</th><th class="hide-s">Prerequisites</th><th class="hide-s">Rounds</th></tr></thead><tbody>
    ${items.map(i => `<tr data-open="work:${esc(i.key)}" tabindex="0"><td class="num">${i.rank ? `${i.rank}<span class="muted"> of ${i.rank_of}</span>` : ''}</td><td class="clip"><b>${i.type === 'change' ? 'PR ' : ''}#${i.number}</b> ${esc(i.title)}</td><td>${esc(words(i.stage))}</td>
      <td class="clip">${status(i.condition, i.condition.reason_code === 'unrecorded' ? 'Held, no reason recorded' : words(i.condition.state))} <span class="reason">${esc(i.condition.reason_text || '')}</span></td><td class="hide-s">${esc(i.agent || '')}</td><td class="hide-s">${pre(i.prerequisites)}</td><td class="hide-s mono small">${rounds(i.change)}</td></tr>`).join('')}</tbody></table></div>`;
  const board = `<div class="board">${d.stages.map(st => { const col = items.filter(i => i.stage === st); return `<div class="col"><h3><span>${esc(words(st))}</span><span>${col.length}</span></h3>${col.map(i => `<div class="tile ${toneOf(i.condition) === 'you' ? 'you' : toneOf(i.condition) === 'fault' ? 'fault' : ''}" data-open="work:${esc(i.key)}" tabindex="0"><div><b>${i.type === 'change' ? 'PR ' : ''}#${i.number}</b>${i.rank ? ` <span class="muted small">rank ${i.rank}</span>` : ''}</div><div class="small">${esc(i.title)}</div><div class="small">${status(i.condition, i.condition.reason_code === 'unrecorded' ? 'No reason recorded' : words(i.condition.reason_code || i.condition.state))}</div></div>`).join('') || '<div class="muted small" style="padding:4px">None</div>'}</div>`; }).join('')}</div>`;
  return `<h1>Queue</h1><div class="toolbar">${Object.keys(names).map(k => chip(names[k], base.filter(QF[k]).length, u.filter === k, `data-ui="queue.filter" data-val="${k}"`)).join('')}
    ${u.stage ? chip(`Stage: ${words(u.stage)} ✕`, null, true, 'data-ui="queue.stage" data-val=""') : ''}
    <input type="search" id="q-queue" placeholder="Search number or title" value="${esc(u.q)}" data-q="queue" aria-label="Search the queue">
    <span class="seg" role="group" aria-label="View">${['table', 'board'].map(v => `<button aria-pressed="${u.view === v}" data-ui="queue.view" data-val="${v}">${words(v)}</button>`).join('')}</span></div>
    <div class="muted small" style="margin-bottom:8px">${d.summary.ranked} ranked · ${d.summary.held} held · ${d.summary.parked} parked · ${d.summary.open_changes} of ${d.summary.max_open_changes ?? '?'} open PRs</div>
    ${items.length ? (u.view === 'board' ? board : table) : '<div class="empty">Nothing matches these filters.</div>'}`;
}

const INBOX_VIEWS = [{ name: 'Waiting for me', state: ['waiting_for_approval'], kind: [] }, { name: 'Failed', state: ['failed'], kind: [] }, { name: 'Refused', state: ['refused'], kind: [] }, { name: 'All', state: [], kind: [] }];
const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
function inboxItems() {
  const u = S.ui.inbox, q = u.q.toLowerCase();
  const items = S.m.inbox.data.items.filter(i => (!u.state.length || u.state.includes(i.state)) && (!u.kind.length || u.kind.includes(i.kind)) && (!q || `${i.id} ${i.title}`.toLowerCase().includes(q)));
  return items.sort((a, b) => (u.sort === 'oldest' ? 1 : -1) * (Date.parse(a.created_at) - Date.parse(b.created_at)));
}
function inbox() {
  const d = S.m.inbox.data, u = S.ui.inbox, all = d.items, items = inboxItems(), shown = items.slice(0, u.shown);
  const count = (key, v) => all.filter(i => i[key] === v).length;
  const stState = s => ({ state: s, attention: s === 'waiting_for_approval' ? 'homeowner' : s === 'failed' ? 'fault' : 'none' });
  const check = i => (i.state === 'waiting_for_approval' ? `<input type="checkbox" data-sel="${i.id}" ${S.sel.has(i.id) ? 'checked' : ''} aria-label="Select ${esc(i.title)}">` : '<span style="width:13px;display:inline-block"></span>');
  const meta = i => `${idChip(i.id)} <span class="muted small">${esc(words(i.kind))} · ${fmtTime(i.created_at)}${i.parked ? ' · parked' : ''}</span>`;
  const card = i => `<article class="card ${toneOf(stState(i.state)) === 'you' ? 'you' : i.state === 'failed' ? 'fault' : ''}"><div class="row">${check(i)}${status(stState(i.state))}${meta(i)}</div>
    <h3 style="margin-top:6px"><button class="link" data-open="inbox:${i.id}" style="color:inherit;text-decoration:none;font-weight:600">${esc(i.title)}</button></h3>
    ${i.state === 'waiting_for_approval' ? `<div class="reason small">${esc(i.will_text || '')}</div>` : `<div class="reason small">${esc(i.reason_text || i.result_text || '')}</div>`}<div class="actions">${actionBtns(i.actions)}</div></article>`;
  const row = i => `<tr data-open="inbox:${i.id}" tabindex="0" class="${S.sel.has(i.id) ? 'sel' : ''}"><td data-stop>${check(i)}</td><td>${idChip(i.id)}</td><td>${status(stState(i.state))}</td><td class="hide-s">${esc(words(i.kind))}</td><td class="clip">${esc(i.title)}</td><td class="hide-s">${fmtTime(i.created_at)}</td><td class="clip hide-s reason">${esc(i.reason_text || i.result_text || '')}</td><td data-stop><div class="row" style="gap:4px;flex-wrap:nowrap">${actionBtns(i.actions.slice(0, 2), true)}</div></td></tr>`;
  const line = i => `<div class="line" data-open="inbox:${i.id}" tabindex="0"><span data-stop>${check(i)}</span><i class="dot t-${toneOf(stState(i.state))}" title="${words(i.state)}"></i><span class="t">${esc(i.title)}</span><span class="muted small hide-s">${esc(words(i.kind))}</span><span class="mono small muted">${i.id}</span></div>`;
  const render = list => (u.view === 'cards' ? `<div class="cards">${list.map(card).join('')}</div>` : u.view === 'table' ? `<div class="tablewrap"><table><thead><tr><th></th><th>Id</th><th>State</th><th class="hide-s">Kind</th><th>Title</th><th class="hide-s">Created</th><th class="hide-s">Result or reason</th><th>Actions</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>` : `<div class="list tablewrap">${list.map(line).join('')}</div>`);
  let body;
  if (!shown.length) body = `<div class="empty">${all.length ? 'Nothing matches these filters.' : 'The Inbox is empty.'}</div>`;
  else if (u.group === 'none') body = render(shown);
  else { const groups = new Map(); for (const i of shown) { if (!groups.has(i[u.group])) groups.set(i[u.group], []); groups.get(i[u.group]).push(i); } body = [...groups].map(([g, list]) => `<h2 style="margin-top:var(--gap)">${esc(words(g))} (${list.length})</h2>${render(list)}`).join(''); }
  const views = [...INBOX_VIEWS, ...S.ui.views];
  const selWaiting = [...S.sel].filter(id => all.find(i => i.id === id)?.state === 'waiting_for_approval');
  return `<h1>Inbox <span class="muted" style="font-weight:400">${items.length} of ${d.page.total}</span></h1>
    <div class="toolbar" aria-label="Saved views">${views.map((v, n) => chip(v.name, null, same(v.state, u.state) && same(v.kind, u.kind), `data-view="${n}"`)).join('')}<button class="btn ghost" data-ui="saveview">Save this view</button></div>
    <div class="toolbar only-s"><button class="btn" data-ui="inbox.filters" data-val="${u.filters === 'open' ? 'closed' : 'open'}" aria-expanded="${u.filters === 'open'}">Filters: ${u.state.length ? u.state.map(words).join(', ') : 'any state'}${u.kind.length ? '; ' + u.kind.map(words).join(', ') : ''}</button></div>
    <div class="toolbar filters ${u.filters === 'open' ? '' : 'closed'}" aria-label="State">${Object.keys(d.facets.state).sort().map(s => chip(words(s), count('state', s), u.state.includes(s), `data-ui="inbox.state" data-toggle="${s}"`)).join('')}</div>
    <div class="toolbar filters ${u.filters === 'open' ? '' : 'closed'}" aria-label="Kind">${Object.keys(d.facets.kind).sort().map(k => chip(words(k), count('kind', k), u.kind.includes(k), `data-ui="inbox.kind" data-toggle="${k}"`)).join('')}</div>
    <div class="toolbar">
      <input type="search" id="q-inbox" placeholder="Search id or title" value="${esc(u.q)}" data-q="inbox" aria-label="Search the Inbox">
      <span class="seg" role="group" aria-label="View">${['cards', 'table', 'list'].map(v => `<button aria-pressed="${u.view === v}" data-ui="inbox.view" data-val="${v}">${words(v)}</button>`).join('')}</span>
      <button class="btn" data-ui="inbox.sort" data-val="${u.sort === 'newest' ? 'oldest' : 'newest'}">Sort: ${u.sort} first</button>
      <button class="btn" data-ui="inbox.group" data-val="${{ none: 'kind', kind: 'state', state: 'none' }[u.group]}">Group: ${u.group}</button></div>
    ${body}${items.length > shown.length ? `<div class="row" style="justify-content:center;margin-top:var(--gap)"><button class="btn" data-ui="inbox.more">Show ${Math.min(60, items.length - shown.length)} more (${items.length - shown.length} left)</button></div>` : ''}
    ${selWaiting.length ? `<div class="bulk"><b>${selWaiting.length} selected</b><button class="btn primary" data-bulk="approve">Approve ${selWaiting.length}</button><button class="btn" data-bulk="reject">Reject ${selWaiting.length}</button><button class="btn ghost" data-bulk="clear">Clear</button></div>` : items.some(i => i.state === 'waiting_for_approval') ? '<div class="muted small" style="margin-top:8px"><button class="link" data-bulk="all">Select all waiting items shown</button></div>' : ''}`;
}

function jobs() {
  const d = S.m.jobs.data, u = S.ui.jobs, q = u.q.toLowerCase();
  const F = { all: () => true, faults: j => toneOf(j.condition) === 'fault', running: j => j.condition.state === 'running', completed: j => j.condition.state === 'completed', stopped: j => j.condition.state === 'stopped' };
  const base = d.items.filter(j => (!u.kind || j.kind === u.kind) && (!u.cause || j.cause_code === u.cause) && (!q || `${j.id} ${j.target?.label || ''} ${j.target?.title || ''}`.toLowerCase().includes(q)));
  const items = base.filter(F[u.filter] || F.all), kinds = [...new Set(d.items.map(j => j.kind))];
  return `<h1>Jobs</h1><div class="toolbar">${Object.keys(F).map(k => chip(words(k === 'faults' ? 'failed or blocked' : k), base.filter(F[k]).length, u.filter === k, `data-ui="jobs.filter" data-val="${k}"`)).join('')}</div>
    <div class="toolbar">${kinds.map(k => chip(words(k), d.items.filter(j => j.kind === k).length, u.kind === k, `data-ui="jobs.kind" data-val="${u.kind === k ? '' : k}"`)).join('')}
      ${u.cause ? chip(`Cause: ${words(u.cause)} ✕`, null, true, 'data-ui="jobs.cause" data-val=""') : ''}<input type="search" id="q-jobs" placeholder="Search id or target" value="${esc(u.q)}" data-q="jobs" aria-label="Search jobs"></div>
    <div class="muted small" style="margin-bottom:8px">Last 24 h: ${d.summary.running} running · ${d.summary.ended} ended · ${fmtTok(d.summary.tokens)} tokens · ${fmtGbp(d.summary.cost_pence)} usage equivalent (jobs with no cost figure are not counted as zero)</div>
    ${items.length ? `<div class="tablewrap"><table><thead><tr><th>Id</th><th>Kind</th><th>Target</th><th>State</th><th class="hide-s">Cause</th><th class="hide-s">Agent</th><th class="hide-s">Model</th><th class="num">Tokens</th><th class="num hide-s">Cost</th><th class="num hide-s">Duration</th><th class="hide-s">Started</th></tr></thead><tbody>
    ${items.map(j => `<tr data-open="job:${j.id}" tabindex="0"><td data-stop>${idChip(j.id)}</td><td>${esc(words(j.kind))}</td><td class="clip">${esc(j.target?.label || '')}</td><td>${status(j.condition)}</td><td class="clip hide-s reason">${esc(j.cause_text || '')}</td><td class="hide-s">${esc(j.agent)}</td><td class="hide-s">${j.model ? esc(j.model) : '<span class="muted">default</span>'}</td><td class="num">${fmtTok(j.tokens?.total)}</td><td class="num hide-s">${j.cost_pence == null ? '<span class="stale-mark">unknown</span>' : fmtGbp(j.cost_pence)}</td><td class="num hide-s">${fmtDur(j.duration_seconds)}</td><td class="hide-s">${fmtTime(j.started_at)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No jobs match these filters.</div>'}`;
}

function meter(w, stale) {
  if (w.state !== 'known') return `<div class="meter unknown" role="img" aria-label="unknown"></div><div class="small stale-mark">Unknown: ${esc(w.reason_text)}</div>`;
  return `<div class="meter ${w.level}" role="img" aria-label="${pct(w.used_fraction)} used"><i style="width:${Math.max(1, Math.round(w.used_fraction * 100))}%"></i></div><div class="small"><b class="${stale ? 'stale-mark' : ''}">${pct(w.used_fraction)}</b> used${stale ? ' (as last read)' : ''} · resets ${fmtTime(w.resets_at)}</div>`;
}
function agentCard(a) {
  const b = a.brief, stale = b.reading.stale;
  return `<section class="card ${stale ? 'unknown' : ''}"><div class="row"><h3 style="margin:0">${esc(b.display_name)}</h3>${status(b.condition)}<span class="muted small">${esc(b.roles.join(', '))}</span></div><div class="reason">${esc(b.condition.reason_text || '')}</div>
    <div class="grid cols-2" style="margin-top:var(--gap)"><div><h2>Weekly</h2>${meter(b.weekly, stale)}</div><div><h2>5 hour</h2>${meter(b.short, stale)}</div></div>
    <div style="margin-top:8px">${stale ? status({ state: 'stale', attention: 'unknown' }, `Reading is ${fmtDur(b.reading.age_seconds)} old`) : `<span class="muted small">Read ${fmtDur(b.reading.age_seconds)} ago</span>`} <span class="muted small">(${fmtTime(b.reading.read_at)}; stale after ${fmtDur(b.reading.max_age_seconds)})</span></div>
    <dl class="kv small" style="margin-top:8px"><dt>Scheduling mode</dt><dd>${esc(words(a.mode))}${a.mode_reason_text ? ` · ${esc(a.mode_reason_text)}` : ''}</dd><dt>Projected at reset</dt><dd>${a.projected_fraction == null ? 'unknown' : pct(a.projected_fraction)}</dd><dt>Tokens, 7 days</dt><dd>${fmtTok(a.tokens_window)}</dd><dt>Cost, 7 days</dt><dd>${fmtGbp(a.cost_pence_window)}</dd></dl>
    <div class="actions">${actionBtns(a.actions)}</div></section>`;
}
function allowance() {
  const d = S.m.allowance.data, w = d.waste, max = Math.max(...w.by_cause.map(c => c.tokens), 1);
  return `<h1>Allowance and budget</h1><div class="grid cols-2">${d.agents.map(agentCard).join('')}</div>
    <div class="grid cols-2" style="margin-top:var(--gap)"><section class="card"><h2>Limit resets available</h2>${d.limit_resets.map(r => `<div class="item"><b>${r.count} × ${esc(words(r.limit))}</b> for ${esc(r.agent)} (${esc(r.scope)}) <span class="muted">${r.expires_at ? `expire ${fmtTime(r.expires_at)}` : 'no expiry recorded'}</span><div class="reason">${esc(r.advice_text || '')}</div></div>`).join('')}</section>
    <section class="card"><h2>Monthly credit agent</h2>${d.credit ? `${status(d.credit.condition)} <span class="reason">${esc(d.credit.condition.reason_text || '')}</span><dl class="kv small" style="margin-top:8px"><dt>Budget</dt><dd>${fmtGbp(d.credit.budget_pence)}</dd><dt>Spent this cycle</dt><dd>${fmtGbp(d.credit.spent_pence)}</dd></dl>` : '<div class="empty">No credit agent configured.</div>'}</section></div>
    <section class="card" style="margin-top:var(--gap)"><h2>Token waste by cause, ${fmtDur(w.window_seconds)}</h2><div class="muted small">${w.jobs} jobs · ${fmtTok(w.tokens)} tokens · ${fmtGbp(w.cost_pence)} usage equivalent</div>
    <div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>Cause</th><th class="num">Jobs</th><th class="num">Tokens</th><th class="num">Share</th><th class="num hide-s">PRs hit</th><th class="num hide-s">Cost</th><th style="width:30%" class="hide-s"></th></tr></thead><tbody>
    ${w.by_cause.map(c => `<tr data-go="#/jobs?kind=${esc(c.job_kind || '')}&cause=${esc(c.code)}" tabindex="0"><td>${esc(c.text)}</td><td class="num">${c.jobs}</td><td class="num">${fmtTok(c.tokens)}</td><td class="num">${pct(c.fraction)}</td><td class="num hide-s">${c.changes ?? ''}</td><td class="num hide-s">${fmtGbp(c.cost_pence)}</td><td class="hide-s"><div class="bar" style="width:${Math.round(c.tokens / max * 100)}%"></div></td></tr>`).join('')}</tbody></table></div></section>`;
}

function audit() {
  const d = S.m.audit.data, u = S.ui.audit, dc = d.direct_control;
  const F = { all: () => true, overseer: e => e.actor === 'overseer', homeowner: e => e.actor === 'homeowner', refused: e => e.outcome === 'refused', undoable: e => e.undo?.available };
  const entries = d.entries.filter(F[u.filter]);
  const diff = e => (e.before || e.after ? `${esc(Object.entries(e.before || {}).map(([k, v]) => `${k}: ${v ?? 'none'}`).join(', ') || 'none')} → ${esc(Object.entries(e.after || {}).map(([k, v]) => `${k}: ${v ?? 'none'}`).join(', ') || 'none')}` : '');
  const tone = e => ({ applied: { state: 'done', attention: 'none' }, refused: { state: 'refused', attention: 'fault' }, undone: { state: 'off', attention: 'none' }, no_change: { state: 'off', attention: 'none' } }[e.outcome]);
  return `<h1>Direct control audit</h1><section class="card"><div class="row" style="justify-content:space-between"><div><h3>Overseer direct control</h3><div class="reason">When on, the overseer may start, resume, pause, stop, reorder, park and edit queued work without a card, with a reason each time. When off, it can only read and propose.</div>
      <div class="muted small">Last changed ${fmtTime(dc.changed_at)} by ${esc(dc.changed_by || 'unknown')}</div></div>
      <div class="switch"><span><b>${dc.enabled ? 'On' : 'Off'}</b></span><button role="switch" aria-checked="${dc.enabled}" aria-label="Overseer direct control" data-cmd="${attr(dc.actions[0])}"></button></div></div></section>
    <div class="toolbar" style="margin-top:var(--gap)">${Object.keys(F).map(k => chip(words(k), d.entries.filter(F[k]).length, u.filter === k, `data-ui="audit.filter" data-val="${k}"`)).join('')}<span class="muted small">Last 24 h: ${d.summary.applied} applied · ${d.summary.refused} refused · ${d.summary.undone} undone</span></div>
    <div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>Command</th><th>Target</th><th class="hide-s">Reason</th><th class="hide-s">Before → after</th><th>Outcome</th><th>Undo</th></tr></thead><tbody>
    ${entries.map(e => `<tr data-open="audit:${e.id}" tabindex="0"><td>${fmtTime(e.at).slice(-5)}</td><td>${esc(e.actor)}</td><td class="mono small">${esc(e.command)}</td><td class="clip">${esc(e.target?.label || '')}</td><td class="clip hide-s reason">${esc(e.reason || '')}</td><td class="clip hide-s small">${diff(e)}</td>
      <td>${status(tone(e), words(e.outcome))}${e.refusal_text ? `<div class="why-not hide-s">${esc(e.refusal_text)}</div>` : ''}</td><td data-stop>${e.undo?.available ? `<button class="btn" data-cmd="${attr({ command: 'audit.undo', input: { audit_id: e.id } })}">Undo</button>` : e.undo?.undone_by ? `<span class="muted small">undone by ${esc(e.undo.undone_by)}</span>` : '<span class="muted small">' + (e.undo ? 'window passed' : 'not reversible') + '</span>'}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------- side panel: everything known about one item
const kv = rows => `<dl class="kv">${rows.filter(r => r[1] != null && r[1] !== '').map(r => `<dt>${esc(r[0])}</dt><dd>${r[1]}</dd>`).join('')}</dl>`;
function panelHtml() {
  const [kind, key] = S.panel.split(':'); let title = '', body = '';
  if (kind === 'work') {
    const row = S.m.queue?.data.items.find(i => i.key === key), det = S.detail[key], i = det?.data.item || row;
    if (!i) return `<header><h3>${esc(refLabel(key))}</h3><button class="btn" data-close>Close</button></header><div class="empty">${det === null ? 'This item is not in the queue read model.' : 'Loading'}</div>`;
    title = `${i.type === 'change' ? 'PR ' : ''}#${i.number} ${esc(i.title)}`;
    body = `<section>${status(i.condition, i.condition.reason_code === 'unrecorded' ? 'Held, no reason recorded' : words(i.condition.state))}<div class="reason">${esc(i.condition.reason_text || '')}</div><div class="actions">${actionBtns(i.actions)}</div></section>
      <section>${kv([['Stage', esc(words(i.stage))], ['Rank', i.rank ? `${i.rank} of ${i.rank_of}` : null], ['Agent', esc(i.agent || '')], ['Since', i.condition.since ? fmtTime(i.condition.since) : null], ['Prerequisite line', i.prerequisites.raw_line ? `<span class="mono small">${esc(i.prerequisites.raw_line)}</span>${i.prerequisites.line_state === 'malformed' ? ' <b style="color:var(--fault)">malformed</b>' : ''}` : null],
        ['Rounds', i.change ? `${i.change.review_rounds} review · ${i.change.fix_rounds} of ${i.change.fix_limit} fix · ${i.change.rebase_attempts} rebase` : null], ['Checks', i.change ? esc(words(i.change.checks)) : null], ['Head', i.change?.head ? idChip(i.change.head) : null], ['Source', i.url ? `<a href="${esc(i.url)}" rel="noreferrer">${esc(i.source)} ${esc(i.project)}</a>` : null]])}</section>`;
    if (det?.data) { const x = det.data;
      body += `${x.decision_proposal ? `<section><h2>Decision proposal</h2><b>${esc(x.decision_proposal.title)}</b><div class="muted small">Key ${idChip(x.decision_proposal.key)} · register number ${x.decision_proposal.number ? esc(x.decision_proposal.number) : 'not assigned until it merges'} · ${esc(words(x.decision_proposal.state))}</div></section>` : ''}
      <section><h2>Reviews (${x.reviews.length} rounds)</h2>${x.reviews.map(r => `<div class="item"><b>Round ${r.round}</b> ${esc(r.reviewer || '')} · ${esc(words(r.verdict))} at ${esc(r.head || '')} <span class="muted small">${fmtTime(r.at)}</span>${r.findings.map(f => `<div class="small">${f.blocking ? '<b>Blocking</b>' : 'Note'} (${esc(words(f.scope))}): ${esc(f.text)}</div>`).join('')}</div>`).join('')}</section>
      <section><h2>Fix and rebase</h2>${kv([['Fix rounds', `${x.fix.rounds} of ${x.fix.limit}${x.fix.limit_reached ? ' (limit reached)' : ''}`], ['Rebase', `${x.rebase.attempts} attempts${x.rebase.capped ? ', retry capped' : ''}`], ['Rebase cause', esc(x.rebase.cause_text || '')]])}</section>
      <section><h2>Requirements (${x.requirements.filter(r => r.status === 'met').length} of ${x.requirements.length} met)</h2>${x.requirements.map(r => `<div class="item small"><b>${r.row}.</b> ${esc(r.text)} <span class="muted">[${esc(words(r.when))}] ${esc(words(r.status))}</span></div>`).join('')}</section>
      <section><h2>Expected files</h2><div class="mono small">${x.expected_files.map(esc).join('<br>')}</div></section>
      <section><h2>Jobs (${x.jobs.length})</h2>${x.jobs.map(j => `<div class="item small"><button class="link" data-open="job:${j.id}">${j.id}</button> ${esc(words(j.kind))} · ${status(j.condition)} · ${fmtTok(j.tokens?.total)} tokens</div>`).join('')}</section>
      <section><h2>Timeline</h2><ul class="timeline">${x.timeline.map(t => `<li class="small"><span class="muted">${fmtTime(t.at)}</span> ${esc(t.text)}</li>`).join('')}</ul></section>`; }
    else body += `<section class="muted small">${det === null ? 'The mock core has no detail fixture for this item; the row data above is everything it serves.' : 'Loading detail'}</section>`;
  } else if (kind === 'job') {
    const j = S.m.jobs.data.items.find(x => x.id === key) || Object.values(S.detail).flatMap(d => d?.data?.jobs || []).find(x => x.id === key);
    if (!j) return `<header><h3>Job ${esc(key)}</h3><button class="btn" data-close>Close</button></header><div class="empty">This job is not in the jobs read model.</div>`;
    title = `Job ${j.id}: ${esc(words(j.kind))} ${esc(j.target?.label || '')}`;
    body = `<section>${status(j.condition)}<div class="reason">${esc(j.condition.reason_text || '')}</div><div class="actions">${actionBtns(j.actions)}</div></section><section>${kv([['Id', idChip(j.id) + ` <span class="mono small muted">${j.full_id}</span>`], ['Kind and role', `${esc(words(j.kind))} · ${esc(j.role)}`], ['Agent', esc(j.agent)], ['Model', j.model ? esc(j.model) : 'agent default'], ['Effort', esc(j.effort || '')],
      ['Cause', j.cause_code ? `${esc(j.cause_text)} <span class="mono small muted">${esc(j.cause_code)}</span>` : null], ['Started by', esc(words(j.trigger))], ['Target', esc(`${j.target?.label || ''} ${j.target?.title || ''}`)], ['Tokens', j.tokens ? `${j.tokens.total.toLocaleString('en-GB')} (${fmtTok(j.tokens.input)} in, ${fmtTok(j.tokens.output)} out)` : 'unknown'],
      ['Cost', j.cost_pence == null ? 'unknown' : `${fmtGbp(j.cost_pence)} (${esc(words(j.cost_basis))})`], ['Started', fmtTime(j.started_at)], ['Ended', j.ended_at ? fmtTime(j.ended_at) : 'still running'], ['Duration', fmtDur(j.duration_seconds)], ['Attempts', j.attempts], ['Transcript', j.has_transcript ? `GET ${API}/jobs/${j.id}/transcript` : 'none']])}</section>`;
  } else if (kind === 'inbox') {
    const i = S.m.inbox.data.items.find(x => x.id === key); if (!i) return '';
    title = esc(i.title);
    body = `<section>${status({ state: i.state, attention: i.attention })} ${idChip(i.id)}<div class="actions">${actionBtns(i.actions)}</div></section><section>${kv([['Kind', esc(words(i.kind))], ['Proposed by', esc(i.proposed_by)], ['Created', fmtTime(i.created_at)], ['Decided', i.decided_at ? fmtTime(i.decided_at) : null], ['Why', esc(i.why || '')], ['Approving does', esc(i.will_text || '')], ['Target', i.target ? esc(i.target.label) : null], ['Job', i.job_id ? idChip(i.job_id) : null], ['Result', esc(i.result_text || '')], ['Reason', i.reason_text ? `${esc(i.reason_text)} <span class="mono small muted">${esc(i.reason_code)}</span>` : null]])}</section>${i.body_text ? `<section><h2>Text</h2><pre class="body">${esc(i.body_text)}</pre></section>` : ''}`;
  } else if (kind === 'audit') {
    const e = S.m.audit.data.entries.find(x => x.id === key); if (!e) return '';
    title = `${esc(e.command)} by ${esc(e.actor)}`;
    body = `<section>${kv([['Audit id', idChip(e.id)], ['When', fmtTime(e.at)], ['Who', `${esc(e.actor)} via ${esc(e.client || 'unknown')}`], ['Target', esc(`${e.target?.label || ''} ${e.target?.title || ''}`)], ['Input', `<span class="mono small">${esc(JSON.stringify(e.input))}</span>`], ['Reason', esc(e.reason || '')], ['Before', `<span class="mono small">${esc(JSON.stringify(e.before))}</span>`], ['After', `<span class="mono small">${esc(JSON.stringify(e.after))}</span>`], ['Outcome', esc(words(e.outcome))], ['Refusal', e.refusal_text ? `${esc(e.refusal_text)} <span class="mono small muted">${esc(e.refusal_code)}</span>` : null], ['Undo', e.undo ? `<span class="mono small">${esc(e.undo.command)} ${esc(JSON.stringify(e.undo.input))}</span>` : 'not reversible']])}</section>`;
  }
  return `<header><h3 style="margin:0">${title}</h3><button class="btn" data-close aria-label="Close details">Close</button></header>${body}`;
}
async function openPanel(ref) {
  S.panel = ref; const [kind, key] = ref.split(':');
  if (kind === 'work' && S.detail[key] === undefined) { renderPanel(); try { S.detail[key] = await api(`/work-items/${key}`); } catch { S.detail[key] = null; } }
  renderPanel();
}
function renderPanel() { const p = $('panel'); if (!S.panel) { p.hidden = true; return; } p.hidden = false; p.innerHTML = panelHtml(); }

// ---------- render, preserving scroll, focus and typed text
const SCREENS = { overview, queue, inbox, jobs, allowance, audit };
function render() {
  document.documentElement.dataset.theme = S.ui.theme; document.documentElement.dataset.density = S.ui.density;
  const active = document.activeElement, focusId = active?.id, caret = active?.selectionStart, y = scrollY;
  renderAppbar(); renderNav(); renderBanner();
  const need = S.route.screen, model = S.m[need];
  $('main').innerHTML = model ? SCREENS[need]() : `<div class="empty">${S.error ? `Cannot read ${esc(need)} from Foreman (${esc(S.error)}). Nothing is shown rather than old data.` : 'Loading'}</div>`;
  renderPanel();
  if (focusId && $(focusId)) { $(focusId).focus(); try { $(focusId).setSelectionRange(caret, caret); } catch { /* not a text field */ } }
  scrollTo(0, y);
}
function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?'), p = new URLSearchParams(query), screen = SCREENS[path] ? path : 'overview';
  S.route = { screen };
  if (screen === 'inbox' && p.has('state')) { S.ui.inbox.state = p.get('state').split(',').filter(Boolean); S.ui.inbox.kind = (p.get('kind') || '').split(',').filter(Boolean); }
  if (screen === 'jobs') { S.ui.jobs.kind = p.get('kind') || null; S.ui.jobs.cause = p.get('cause') || null; S.ui.jobs.filter = 'all'; }
  if (screen === 'queue') { S.ui.queue.stage = p.get('stage') || null; if (p.get('filter')) S.ui.queue.filter = p.get('filter'); }
  render(); scrollTo(0, 0);
}

// ---------- commands: applied in place, no reload; every result gets a toast, refusals say why, reversible ones offer Undo
function toast(text, { refused = false, undo = null } = {}) {
  const el = document.createElement('div'); el.className = `toast${refused ? ' refused' : ''}`; el.innerHTML = `<span>${esc(text)}</span>`;
  if (undo) { const b = document.createElement('button'); b.textContent = 'Undo'; b.onclick = () => { el.remove(); run({ command: undo.command, input: undo.input }); }; el.append(b); }
  $('toasts').append(el); setTimeout(() => el.remove(), undo ? 12000 : 6000);
}
function askReason(text, required) {
  return new Promise(resolve => { const d = $('dialog');
    d.innerHTML = `<form method="dialog"><h3 style="margin-top:0">${esc(text)}</h3><label for="reason">Reason${required ? ' (required, recorded in the audit trail)' : ' (optional)'}</label><textarea id="reason" ${required ? 'required' : ''}></textarea><div class="row" style="justify-content:flex-end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Confirm</button></div></form>`;
    d.onclose = () => resolve(d.returnValue === 'ok' ? d.querySelector('textarea').value.trim() : null); d.showModal(); });
}
const INBOX_STATE = { 'inbox.approve': 'approved', 'inbox.reject': 'rejected', 'inbox.undo_decision': 'waiting_for_approval', 'inbox.requeue': 'waiting_for_approval', 'inbox.dismiss': 'done' };
function patchLocal(a, res) {   // update what is on screen from the command result, without waiting for a refetch
  if (a.command.startsWith('inbox.') && S.m.inbox) {
    const i = S.m.inbox.data.items.find(x => x.id === a.input.id); if (!i) return;
    if (a.command === 'inbox.park' || a.command === 'inbox.unpark') i.parked = a.command === 'inbox.park';
    else { i.state = res.result?.condition?.state || INBOX_STATE[a.command] || i.state; i.attention = i.state === 'waiting_for_approval' ? 'homeowner' : 'none'; i.decided_at = new Date().toISOString();
      i.actions = i.state === 'waiting_for_approval' ? ['approve', 'reject', 'park'].map((v, n) => ({ command: `inbox.${v}`, input: { id: i.id }, enabled: true, tier: 'person_only', reversible: true, primary: n === 0 })) : []; }
    S.sel.delete(i.id);
    const waiting = S.m.inbox.data.items.filter(x => x.state === 'waiting_for_approval').length;
    if (S.m.appbar) S.m.appbar.data.counts.inbox_waiting = waiting;
    const g = S.m.overview?.data.needs_you.find(n => n.id === 'inbox-waiting'); if (g && waiting) { g.count = waiting; g.title = `${waiting} Inbox item${waiting === 1 ? ' waits' : 's wait'} for approval`; }
    if (g && !waiting) { S.m.overview.data.needs_you = S.m.overview.data.needs_you.filter(n => n !== g); if (S.m.appbar) S.m.appbar.data.counts.needs_you = S.m.overview.data.needs_you.length; }
  }
  if (a.command === 'direct_control.set') for (const m of [S.m.appbar?.data.direct_control, S.m.audit?.data.direct_control]) if (m) { m.enabled = a.input.enabled; m.changed_at = new Date().toISOString(); m.changed_by = 'homeowner'; if (m.actions) m.actions = [{ ...m.actions[0], input: { enabled: !a.input.enabled } }]; }
  if (a.command === 'audit.undo' && S.m.audit) { const e = S.m.audit.data.entries.find(x => x.id === a.input.audit_id); if (e) { e.outcome = 'undone'; e.undo.available = false; e.undo.undone_by = res.audit_id; } }
}
async function run(a, { quiet = false } = {}) {
  const spec = S.m.meta?.data.commands.find(c => c.name === a.command); let reason = null;
  if (spec?.reason_required || a.command === 'direct_control.set') { reason = await askReason(a.command === 'direct_control.set' ? `Turn overseer direct control ${a.input.enabled ? 'on' : 'off'}?` : `${label(a)}${a.input.key ? ' ' + refLabel(a.input.key) : a.input.id ? ' ' + a.input.id : ''}`, !!spec?.reason_required); if (reason === null) return null; }
  const res = await send(a.command, a.input, reason);
  if (res.ok) { patchLocal(a, res); if (!quiet) toast(`${label(a)}: ${res.outcome === 'accepted' ? 'recorded; Foreman applies it on the next tick' : words(res.outcome)}${res.audit_id ? ` (audit ${res.audit_id})` : ''}`, { undo: res.undo }); }
  else toast(`${label(a)} refused: ${res.refusal_text || res.refusal_code || 'no reason given'}`, { refused: true });
  render(); return res;
}

// ---------- one click handler, by data attributes
const setPath = (path, val) => { const [a, b] = path.split('.'); if (b) S.ui[a][b] = val; else S.ui[a] = val; };
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-copy],[data-cmd],[data-bulk],[data-ui],[data-view],[data-pop],[data-close],[data-sel],[data-open],[data-go]');
  if ($('popover').hidden === false && !e.target.closest('#popover,[data-pop]')) $('popover').hidden = true;
  if (!t) return;
  if (t.dataset.copy) { e.stopPropagation(); try { await navigator.clipboard.writeText(t.dataset.copy); toast(`Copied ${t.dataset.copy}`); } catch { toast(`Copy failed; the id is ${t.dataset.copy}`); } return; }
  if (t.dataset.cmd) { e.stopPropagation(); t.disabled = true; await run(JSON.parse(t.dataset.cmd)); return; }
  if (t.dataset.sel) { S.sel.has(t.dataset.sel) ? S.sel.delete(t.dataset.sel) : S.sel.add(t.dataset.sel); return render(); }
  if (t.dataset.bulk) {
    if (t.dataset.bulk === 'clear') S.sel.clear();
    else if (t.dataset.bulk === 'all') inboxItems().slice(0, S.ui.inbox.shown).filter(i => i.state === 'waiting_for_approval').forEach(i => S.sel.add(i.id));
    else { const ids = [...S.sel]; let ok = 0; for (const id of ids) { const r = await run({ command: `inbox.${t.dataset.bulk}`, input: { id } }, { quiet: true }); if (r?.ok) ok++; } toast(`${words(t.dataset.bulk)}: ${ok} of ${ids.length} applied`); }
    return render();
  }
  if (t.dataset.view) { const v = [...INBOX_VIEWS, ...S.ui.views][Number(t.dataset.view)]; Object.assign(S.ui.inbox, { state: [...v.state], kind: [...v.kind], shown: 60 }); return render(); }
  if (t.dataset.ui) {
    const p = t.dataset.ui;
    if (p === 'theme') S.ui.theme = S.ui.theme === 'dark' ? 'light' : 'dark';
    else if (p === 'density') S.ui.density = S.ui.density === 'compact' ? 'comfortable' : 'compact';
    else if (p === 'inbox.more') S.ui.inbox.shown += 60;
    else if (p === 'saveview') { const name = await askReason('Name this view (state and kind filters are saved for you on this device)', true); if (name) S.ui.views.push({ name, state: [...S.ui.inbox.state], kind: [...S.ui.inbox.kind] }); }
    else if (t.dataset.toggle) { const [a, b] = p.split('.'), list = S.ui[a][b], v = t.dataset.toggle; S.ui[a][b] = list.includes(v) ? list.filter(x => x !== v) : [...list, v]; S.ui.inbox.shown = 60; }
    else setPath(p, t.dataset.val === '' ? null : t.dataset.val);
    persist(); return render();
  }
  if (t.dataset.pop) { const g = S.m.appbar.data.agents.find(x => x.id === t.dataset.pop), r = t.getBoundingClientRect(), pop = $('popover');
    pop.innerHTML = `<div class="row"><b>${esc(g.display_name)}</b>${status(g.condition)}</div><div class="reason">${esc(g.condition.reason_text || '')}</div><div class="grid cols-2" style="margin-top:8px"><div><h2>Weekly</h2>${meter(g.weekly, g.reading.stale)}</div><div><h2>5 hour</h2>${meter(g.short, g.reading.stale)}</div></div>
      <div class="small" style="margin-top:8px">${g.reading.stale ? status({ state: 'stale', attention: 'unknown' }, `Reading is ${fmtDur(g.reading.age_seconds)} old`) : `Read ${fmtDur(g.reading.age_seconds)} ago`} · roles: ${esc(g.roles.join(', '))}</div><div class="actions"><a class="btn" href="#/allowance" style="display:inline-flex;align-items:center;text-decoration:none">Allowance details</a></div>`;
    pop.hidden = false; pop.style.top = `${r.bottom + 6}px`; pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 348))}px`; return; }
  if (t.hasAttribute('data-close')) { S.panel = null; return renderPanel(); }
  if (t.dataset.go) { location.hash = t.dataset.go; return; }
  if (t.dataset.open) openPanel(t.dataset.open);
});
document.addEventListener('input', e => { const q = e.target.dataset?.q; if (q) { S.ui[q].q = e.target.value; if (q === 'inbox') S.ui.inbox.shown = 60; render(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.panel) { S.panel = null; renderPanel(); } if (e.key === 'Enter' && e.target.matches('[data-open],[data-go]')) e.target.click(); });
addEventListener('hashchange', route);

// ---------- live updates: the event stream says which models changed; the client refetches only those and patches in place
let pending = new Set(), timer = null;
const refetch = models => { models.forEach(m => S.m[m] !== undefined && pending.add(m)); clearTimeout(timer); timer = setTimeout(async () => { const list = [...pending]; pending = new Set(); await load(list); render(); }, 200); };
function connect() {
  const es = new EventSource(`${API}/events`);
  const beat = () => { S.live.beat = Date.now(); if (S.live.state !== 'live') { S.live.state = 'live'; renderAppbar(); renderBanner(); } };
  es.addEventListener('hello', beat);
  es.addEventListener('heartbeat', e => { beat(); const f = JSON.parse(e.data).freshness; if (f && S.m.appbar && f.state !== S.m.appbar.freshness.state) { S.m.appbar.freshness = f; renderBanner(); } });
  for (const type of ['model_changed', 'command_applied']) es.addEventListener(type, e => { beat(); refetch(JSON.parse(e.data).models || []); });
  es.addEventListener('freshness_changed', e => { beat(); if (S.m.appbar) { S.m.appbar.freshness = JSON.parse(e.data).freshness; renderBanner(); } });
  es.addEventListener('resync_required', () => { beat(); refetch(Object.keys(S.m)); });
  es.onerror = () => { if (S.live.state === 'live' || S.live.state === 'connecting') { S.live.state = 'reconnecting'; renderAppbar(); } };
  setInterval(() => { if (Date.now() - S.live.beat > 35000 && S.live.state !== 'behind') { S.live.state = 'behind'; renderAppbar(); renderBanner(); } }, 5000);
}

await load(['meta', 'appbar', 'overview', 'queue', 'inbox', 'jobs', 'allowance', 'audit']);
route(); connect();
