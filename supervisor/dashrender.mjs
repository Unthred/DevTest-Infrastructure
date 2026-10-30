// HTML for the team dashboard (issue #32): self-contained, no script, no external resource, charts as inline SVG.
// Every dynamic value goes through esc(). The page refreshes with a meta tag every 60 seconds.
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const utc = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown');
const dur = ms => { if (!Number.isFinite(ms) || ms < 0) return 'unknown'; const m = Math.floor(ms / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`; };
const ago = (ms, now) => (Number.isFinite(ms) ? `${dur(now - ms)} ago` : 'never');
const inFuture = (ms, now) => (Number.isFinite(ms) ? (ms > now ? `in ${dur(ms - now)}` : `${dur(now - ms)} ago`) : 'unknown');
const pct = f => (Number.isFinite(f) ? `${Math.round(f * 100)}%` : 'unknown');
const num = n => (Number.isFinite(n) ? n.toLocaleString('en-GB') : 'unknown');
const ghUrl = (repo, kind, n) => `https://github.com/${esc(repo)}/${kind === 'pull' ? 'pull' : 'issues'}/${Number(n)}`;
const PALETTE = ['#2a6fdb', '#d9822b', '#2e9e6b', '#8a4fd1', '#c2417a', '#7a8794'];

function lineChart(series, resets, title) {
  const keys = Object.keys(series);
  const all = keys.flatMap(k => series[k]);
  if (!all.length) return `<p class="muted">No allowance history yet: ${esc(title)}.</p>`;
  const W = 520, H = 170, L = 34, B = 20, T = 8, R = 8;
  const t0 = Math.min(...all.map(p => p.at)), t1 = Math.max(...all.map(p => p.at), t0 + 60000);
  const x = t => L + ((t - t0) / (t1 - t0)) * (W - L - R), y = v => T + (1 - v) * (H - T - B);
  let g = [0, 0.5, 1].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end" class="ax">${v * 100}%</text>`).join('');
  g += `<text x="${L}" y="${H - 4}" class="ax">${esc(utc(t0))}</text><text x="${W - R}" y="${H - 4}" text-anchor="end" class="ax">${esc(utc(t1))}</text>`;
  for (const r of resets) g += `<line x1="${x(r.at)}" x2="${x(r.at)}" y1="${T}" y2="${H - B}" class="reset"><title>${esc(r.window)} window reset ${esc(utc(r.at))}</title></line>`;
  keys.forEach((k, i) => { g += `<polyline fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="2" points="${series[k].map(p => `${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')}"/>`; });
  const legend = keys.map((k, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(k)}</span>`).join('') + (resets.length ? '<span><i class="rs"></i>reset</span>' : '');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}</svg><div class="legend">${legend}</div>`;
}
function bars(rows, { unit = '', title }) {
  const known = rows.filter(r => Number.isFinite(r.value));
  if (!known.length) return `<p class="muted">No data yet: ${esc(title)}.</p>`;
  const max = Math.max(...known.map(r => r.value), 1), W = 520, rowH = 22, H = rows.length * rowH + 6, L = 130;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${rows.map((r, i) => {
    const w = Number.isFinite(r.value) ? Math.max(2, (r.value / max) * (W - L - 70)) : 0;
    return `<text x="${L - 6}" y="${i * rowH + 15}" text-anchor="end" class="ax">${esc(r.label)}</text>` + (Number.isFinite(r.value) ? `<rect x="${L}" y="${i * rowH + 4}" width="${w.toFixed(1)}" height="14" fill="${PALETTE[(r.color ?? 0) % PALETTE.length]}"/><text x="${L + w + 4}" y="${i * rowH + 15}" class="ax">${esc(num(Math.round(r.value * 10) / 10))}${esc(unit)}</text>` : `<text x="${L}" y="${i * rowH + 15}" class="ax">unknown</text>`);
  }).join('')}</svg>`;
}
function stacked(days, title) {
  const keys = [...new Set(Object.values(days).flatMap(d => Object.keys(d)))].sort();
  const names = Object.keys(days).sort();
  if (!names.length) return `<p class="muted">No jobs recorded yet: ${esc(title)}.</p>`;
  const W = 520, H = 170, L = 28, B = 20, T = 8, bw = Math.min(40, (W - L - 10) / names.length - 6);
  const max = Math.max(...names.map(d => Object.values(days[d]).reduce((a, b) => a + b, 0)), 1);
  let g = `<line x1="${L}" x2="${W - 8}" y1="${H - B}" y2="${H - B}" class="grid"/><text x="${L - 4}" y="${T + 8}" text-anchor="end" class="ax">${max}</text>`;
  names.forEach((d, i) => {
    const x0 = L + 8 + i * (bw + 6); let acc = 0;
    keys.forEach((k, ki) => { const n = days[d][k] || 0; if (!n) return; const h = (n / max) * (H - T - B); acc += h; g += `<rect x="${x0}" y="${(H - B - acc).toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" fill="${PALETTE[ki % PALETTE.length]}"><title>${esc(d)} ${esc(k)}: ${n}</title></rect>`; });
    g += `<text x="${x0 + bw / 2}" y="${H - 6}" text-anchor="middle" class="ax">${esc(d.slice(5))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}</svg><div class="legend">${keys.map((k, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(k)}</span>`).join('')}</div>`;
}

const CSS = `:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1c2330;--mut:#5d6877;--line:#d9dee6;--red:#b3261e;--redbg:#fdecea;--amber:#8a5a00;--amberbg:#fff4d6;--green:#1b7a4b;--link:#1d5fc4}
@media(prefers-color-scheme:dark){:root{--bg:#12161c;--card:#1a2029;--fg:#e4e8ee;--mut:#9aa6b6;--line:#2c3542;--red:#ff8a80;--redbg:#3b1b19;--amber:#f2c14e;--amberbg:#3a2f12;--green:#6fd1a0;--link:#7db0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:12px}h1{font-size:20px;margin:6px 0}h2{font-size:16px;margin:0 0 8px}h3{font-size:14px;margin:10px 0 4px}
a{color:var(--link)}.muted,.ax{color:var(--mut);fill:var(--mut)}.sub{color:var(--mut);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:12px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.attn{background:var(--redbg);border:2px solid var(--red);color:var(--red)}.attn li{margin:4px 0}.attn a{color:inherit;font-weight:600}
.ok{border-color:var(--green)}.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;border:1px solid var(--line)}
.running{color:var(--green);border-color:var(--green)}.paused{color:var(--amber);background:var(--amberbg);border-color:var(--amber)}.blocked{color:var(--red);background:var(--redbg);border-color:var(--red)}.idle{color:var(--mut)}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:3px 6px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}th{font-size:12px;color:var(--mut)}
.bar{height:10px;background:var(--line);border-radius:5px;overflow:hidden;min-width:80px}.bar b{display:block;height:100%;background:#2a6fdb}
svg{width:100%;height:auto;display:block}.grid{stroke:var(--line)}.ax{font-size:10px}.reset{stroke:var(--red);stroke-dasharray:3 3}
.legend{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--mut)}.legend i{display:inline-block;width:10px;height:10px;margin-right:4px;vertical-align:baseline}.legend i.rs{background:none;border-left:2px dashed var(--red);width:0;height:10px}
@media(max-width:560px){main{padding:8px}td,th{padding:3px 4px;font-size:13px}}`;

export function renderPage(view, { refreshSeconds = 60 } = {}) {
  const now = view.generatedAt, repo = view.repository;
  const refLink = r => (r ? `<a href="${ghUrl(repo, r.kind, r.n)}">${r.kind === 'pull' ? 'PR' : 'issue'} #${Number(r.n)}</a>` : '');
  const attention = view.attention.length
    ? `<section class="card attn" aria-label="Needs attention"><h2>Needs attention (${view.attention.length})</h2><ul>${view.attention.map(a => `<li>${esc(a.text)} ${refLink(a.ref)}</li>`).join('')}</ul></section>`
    : `<section class="card ok" aria-label="Needs attention"><h2>Needs attention</h2><p>Nothing needs attention.</p></section>`;
  const tick = view.tick;
  const header = `<p class="sub">Team loop ${view.teamEnabled ? 'enabled' : '<b>disabled</b>'} · last tick: ${tick ? `${esc(tick.status)} ${esc(ago(tick.at, now))}` : 'none recorded'} · GitHub data cached ${esc(ago(view.cacheFetchedAt, now))} · page built ${esc(utc(now))}, refreshes every ${refreshSeconds}s · read-only</p>`;
  const agents = view.agents.map(a => {
    const j = a.job;
    let body = `<p class="muted">No current job.</p>`;
    if (j) {
      body = `<table><tr><th>Job</th><td>${esc(j.kind)} ${j.kind === 'implement' ? refLink({ kind: 'issue', n: j.ref }) : refLink({ kind: 'pull', n: j.ref })} <span class="muted">${esc(j.id)}</span></td></tr>
<tr><th>Branch</th><td>${esc(j.branch)}</td></tr><tr><th>Started</th><td>${esc(utc(j.startedAt))} · elapsed ${esc(dur(j.elapsedMs))}</td></tr>
${a.state === 'paused' ? `<tr><th>Paused by</th><td><b>${esc(j.lastEvent)}</b> (attempt ${j.attempts})</td></tr><tr><th>Reset</th><td>${j.resetAt ? esc(utc(j.resetAt)) : 'none reported'}</td></tr><tr><th>Next attempt</th><td>${j.nextAttemptAt ? `${esc(utc(j.nextAttemptAt))} (${esc(inFuture(j.nextAttemptAt, now))})` : 'by hand'}</td></tr>` : ''}
${a.state === 'blocked' ? `<tr><th>Stopped by</th><td><b>${esc(j.status)}</b>: ${esc(j.lastEvent)}</td></tr>` : ''}</table>`;
    }
    return `<div class="card"><h2>${esc(a.name)} <span class="pill ${esc(a.state)}">${esc(a.state)}</span></h2>${body}<p class="sub">Last activity: ${esc(ago(a.lastActivityAt, now))}</p></div>`;
  }).join('');
  const queue = Object.entries(view.queues).map(([name, items]) => `<div class="card"><h2>Queue: ${esc(name)}</h2>${items.length ? `<table>${items.map(i => `<tr><td>${i.next ? '<b>next</b>' : ''}</td><td><a href="${ghUrl(repo, i.type === 'issue' ? 'issue' : 'pull', i.ref)}">${i.type === 'issue' ? '#' : 'PR #'}${Number(i.ref)}</a> ${esc(i.title)}</td><td>${esc(i.reason)}</td></tr>`).join('')}</table>` : '<p class="muted">Nothing queued.</p>'}</div>`).join('');
  const usage = Object.entries(view.usage).map(([name, u]) => `<div class="card"><h2>Usage: ${esc(name)}</h2>${u.windows.length ? `<table><tr><th>Window</th><th>Used</th><th>Resets</th></tr>${u.windows.map(w => `<tr><td>${esc(w.label)}</td><td>${Number.isFinite(w.utilization) ? `${esc(pct(w.utilization))}<div class="bar"><b style="width:${Math.round(w.utilization * 100)}%"></b></div>` : 'unknown'}</td><td>${w.resetsAt ? esc(utc(w.resetsAt)) + (w.stale ? ' (passed; reading is old)' : '') : 'unknown'}</td></tr>`).join('')}</table><p class="sub">Reported by the provider ${esc(ago(u.observedAt, now))}. Refreshed when a job ends, not live.</p>` : '<p>Allowance: <b>unknown</b> (the provider has reported none yet).</p>'}
<h3>Tokens per job</h3>${u.jobs.length ? `<table><tr><th>Job</th><th>In</th><th>Out</th><th>CLI cost estimate*</th></tr>${u.jobs.map(j => `<tr><td>${esc(j.kind)} #${Number(j.ref)} <span class="muted">${esc(j.id)}</span></td><td>${esc(num(j.inputTokens))}</td><td>${esc(num(j.outputTokens))}</td><td>${j.costUsdEstimate === null ? 'unknown' : '$' + esc(j.costUsdEstimate.toFixed(2))}</td></tr>`).join('')}</table>` : '<p class="muted">Token counts: unknown (none recorded yet).</p>'}
<p class="sub">*The CLI's own estimate, not billing. Subscription use is not billed per token.</p></div>`).join('');
  const gr = view.graphs;
  const allowanceCharts = Object.entries(gr.allowance).map(([a, g]) => `<div class="card"><h2>Allowance used: ${esc(a)}</h2>${lineChart(g.series, g.resets, `${a} allowance used over time`)}</div>`).join('');
  const verdictRows = Object.entries(gr.verdicts).flatMap(([a, v], i) => [{ label: `${a} PASS`, value: v.PASS, color: 2 }, { label: `${a} CHANGES`, value: v.CHANGES, color: 1 }]);
  const mergeRows = gr.merges.slice(-12).map(m => ({ label: `PR #${m.pr}${m.agent ? ' ' + m.agent : ''}`, value: m.hours, color: 0 }));
  const tokRows = gr.tokensPerPr.slice(-12).map(m => ({ label: `PR #${m.pr}${m.agent ? ' ' + m.agent : ''}`, value: m.tokens, color: 3 }));
  const graphs = `${allowanceCharts}<div class="card"><h2>Jobs per day, by kind and outcome</h2>${stacked(gr.jobsPerDay, 'jobs per day')}</div>
<div class="card"><h2>Review verdicts per agent</h2>${bars(verdictRows, { title: 'review verdicts' })}</div>
<div class="card"><h2>Issue start to merge (hours)</h2>${bars(mergeRows, { unit: ' h', title: 'time from issue start to merge' })}</div>
<div class="card"><h2>Tokens per merged PR</h2>${bars(tokRows, { title: 'tokens per merged PR' })}</div>`;
  const act = `<div class="card"><h2>Recent activity (last ${view.activity.length})</h2>${view.activity.length ? `<table>${view.activity.map(r => `<tr><td>${esc(utc(r.at))}</td><td>${esc(r.text)}</td><td>${r.link ? `<a href="${esc(r.link.url)}">${esc(r.link.text)}</a>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted">No events recorded yet.</p>'}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="${refreshSeconds}"><title>DevTest team dashboard</title><style>${CSS}</style></head><body><main>
<h1>DevTest team dashboard</h1>${header}${attention}
<h2>Agents</h2><div class="grid2">${agents}</div><h2>Queue</h2><div class="grid2">${queue}</div><h2>Usage</h2><div class="grid2">${usage}</div>
<h2>Graphs</h2><div class="grid2">${graphs}</div>${act}</main></body></html>`;
}
