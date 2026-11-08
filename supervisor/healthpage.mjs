// Issue #1093: the Health page, Tower's own state: disk use per volume, /tmp growth, and the host load recorder. Pure rendering;
// the data comes from dashserver's healthData (diagnostics.mjs readDiskSamples and readRecorder). `h` carries dashrender's helpers.
const GIB = 1073741824, DAY = 86400000;
const gb = n => `${Math.round(n / GIB * 10) / 10} GB`;
const W = 900, H = 260, L = 44, B = 26, T = 12, R = 14;

// A 7 day percent chart with the warning and alert levels drawn as lines.
function diskChart(h, path, pts, now, warn, alert) {
  const t0 = now - 7 * DAY, x = t => L + ((t - t0) / (now - t0)) * (W - L - R), y = v => T + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - T - B);
  const grid = [0, 25, 50, 75, 100].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gridline"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${v}%</text>`).join('');
  const lines = [[warn, 'var(--warning)', 'Warning'], [alert, 'var(--action)', 'Alert']].map(([v, c, n]) => `<line data-level="${n.toLowerCase()}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${c}" stroke-width="2" stroke-dasharray="6 4"><title>${n} level ${v}%</title></line>`).join('');
  const days = [0, 1, 2, 3, 4, 5, 6, 7].map(i => { const t = t0 + i * DAY; return `<text x="${x(t)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 7 ? 'end' : 'middle'}" class="ax">${h.esc(new Date(t).toISOString().slice(5, 10))}</text>`; }).join('');
  const line = pts.length > 1 ? `<polyline fill="none" stroke="var(--codex)" stroke-width="2.5" stroke-linejoin="round" points="${pts.map(p => `${x(p.at).toFixed(1)},${y(p.pct).toFixed(1)}`).join(' ')}"/>` : '';
  const last = pts.at(-1), dot = last ? `<circle cx="${x(last.at).toFixed(1)}" cy="${y(last.pct).toFixed(1)}" r="5" fill="var(--codex)"><title>${h.esc(path)}: ${last.pct}%</title></circle>` : '';
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${h.esc(`Disk use of ${path} over 7 days`)}">${grid}${days}${lines}${line}${dot}</svg></figure>`;
}

function volumes(samples) {
  const by = new Map();
  for (const s of samples) for (const v of s.volumes) {
    const e = by.get(v.path) || { path: v.path, pts: [], latest: null };
    if (v.status === 'ok') e.pts.push({ at: s.at, pct: Math.round(v.usedBytes / v.totalBytes * 1000) / 10 });
    e.latest = v.status === 'ok' ? { ...v, pct: Math.round(v.usedBytes / v.totalBytes * 1000) / 10 } : { status: 'unreadable' };
    by.set(v.path, e);
  }
  return [...by.values()];
}
const level = (pct, warn, alert) => (pct >= alert ? 'alert' : pct >= warn ? 'warn' : 'ok');

function diskCards(h, d) {
  const none = d.disk.status !== 'ok';
  if (none) {
    const [t, s] = d.disk.status === 'unreadable' ? ['The disk samples file cannot be read', 'The rest of this page does not depend on it.'] : ['No disk samples yet', 'Disk use appears here once the disk recording has written its first sample.'];
    return h.card({ id: 'health-disk', title: 'Disk use', span: 12, movable: false, body: `<p class="sub" data-health-disk="${h.esc(d.disk.status)}">${h.esc(t)}.</p>${h.empty(t, s, 'warn')}` });
  }
  const samples = d.disk.samples, vols = volumes(samples).map(v => ({ ...v, level: v.latest.status === 'ok' ? level(v.latest.pct, d.warn, d.alert) : 'unreadable' }));
  const flagged = vols.filter(v => v.level === 'warn' || v.level === 'alert');
  const worst = flagged.some(v => v.level === 'alert') ? 'alert' : flagged.length ? 'warn' : 'ok';
  const heading = flagged.length ? `Disk use: ${flagged.map(v => `${v.path} ${v.level === 'alert' ? 'at alert level' : 'above warning level'} (${v.latest.pct}%)`).join(', ')}` : 'Disk use';
  const cards = [h.card({ id: 'health-disk', title: heading, span: 12, movable: false, cls: `health-${worst}`,
    body: `<p class="sub" data-health-disk="ok" data-health-level="${worst}">Warning at ${h.esc(d.warn)}%, alert at ${h.esc(d.alert)}%. Last sample ${h.esc(h.utc(samples.at(-1).at))}.</p>` })];
  for (const v of vols) {
    const body = v.level === 'unreadable' ? `<p class="sub" data-health-volume="${h.esc(v.path)}" data-health-level="unreadable">Unreadable: the last sample could not read this volume.</p>`
      : `<p class="sub" data-health-volume="${h.esc(v.path)}" data-health-level="${v.level}"><strong>${v.latest.pct}%</strong> used (${gb(v.latest.usedBytes)} of ${gb(v.latest.totalBytes)})${v.level === 'ok' ? '' : v.level === 'alert' ? ', above the alert level' : ', above the warning level'}.</p>${v.pts.length ? diskChart(h, v.path, v.pts, d.now, d.warn, d.alert) : ''}`;
    cards.push(h.card({ id: `health-vol-${v.path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root'}`, title: `Volume ${v.path}`, span: 12, movable: false, cls: `health-${v.level}`, body }));
  }
  // /tmp entries: current count and the change since the sample nearest 24 hours before the latest
  const tmp = samples.filter(s => s.tmpEntries !== null);
  if (tmp.length) {
    const last = tmp.at(-1), base = tmp.filter(s => s.at <= last.at - DAY).at(-1) || tmp[0], change = last.tmpEntries - base.tmpEntries;
    const spark = tmp.length > 1 ? `<svg class="spark" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="var(--s3)" stroke-width="2" points="${tmp.map((s, i) => `${(i / (tmp.length - 1) * 120).toFixed(1)},${(26 - s.tmpEntries / Math.max(...tmp.map(t => t.tmpEntries), 1) * 24).toFixed(1)}`).join(' ')}"/></svg>` : '';
    cards.push(h.card({ id: 'health-tmp', title: '/tmp entries', span: 12, movable: false, body: `<p class="sub" data-health-tmp="${last.tmpEntries}"><strong>${last.tmpEntries}</strong> entries now; ${change === 0 ? 'no change' : `${change > 0 ? '+' : ''}${change}`} over the last 24 hours${base.at > last.at - DAY ? ' (less than 24 hours of samples)' : ''}.</p><div class="diag-spark">${spark}</div>` }));
  }
  return cards.join('');
}

export function healthPage(route, h) {
  const d = route.data;
  if (!d) return { title: 'Health', body: h.grid('health', h.card({ id: 'health-none', title: 'Health', span: 12, movable: false, body: h.empty('Health is not available here', 'This page was rendered without its data.', 'warn') })) };
  const r = d.recorder, problem = ['missing', 'unreadable', 'empty'].includes(r.status), kb = n => `${Math.round(n / 1048576 * 10) / 10} GiB`;
  const rec = h.card({ id: 'health-recorder', title: 'Load, swap and disk wait from the memory flight recorder', span: 12, movable: false, body: `<p class="sub" data-health-recorder="${h.esc(r.status)}">${problem ? '' : `${h.esc(r.samples)} samples from ${h.esc(r.files)} log file${r.files === 1 ? '' : 's'}. `}${r.note ? h.esc(r.note) : ''}</p>${problem ? h.empty(r.status === 'empty' ? 'No recorder samples in this window' : r.status === 'missing' ? 'Recorder logs not found' : 'Recorder logs not readable', 'The rest of this page does not depend on them.', 'warn')
    : `<div class="diag-sparks">${h.diagSpark(r.hourly, 'loadMax', 'Load average (1 min), hourly peak', '')}${h.diagSpark(r.hourly, 'swapMaxPercent', 'Swap in use, hourly peak', ' %')}${h.diagSpark(r.hourly, 'iowaitAvg', 'CPU waiting on disk, hourly average', ' %')}</div>${h.plainTable(['Day', 'Samples', 'Load avg', 'Load peak', 'Swap peak', 'Disk wait avg', 'Disk wait peak', 'Blocked tasks peak'], r.days.map(x => (x.samples ? [x.day, x.samples, x.loadAvg, x.loadMax, `${x.swapMaxPercent}% (${kb(x.swapMaxKb)})`, `${x.iowaitAvg ?? '–'}%`, `${x.iowaitMax ?? '–'}%`, x.blockedMax] : [x.day, 0, '–', '–', '–', '–', '–', '–'])), 'Recorder figures per day')}<p class="sub">Disk I/O is the share of CPU time spent waiting on disk and the number of blocked tasks, both from the one-minute host samples.</p>`}` });
  const procs = h.card({ id: 'health-processes', title: 'Memory and CPU per job', span: 12, movable: false, body: '<p class="sub">Per job memory and CPU are on the <a href="/system/processes">Processes page</a>.</p>' });
  return { title: 'Health', body: h.grid('health', diskCards(h, d) + rec + procs) };
}
