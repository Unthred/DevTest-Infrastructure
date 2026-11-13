#!/usr/bin/env node
// A second, minimal client of the Foreman v1 contract: a terminal program that shows the app bar line and the stalled banner.
// It proves the interface is swappable: it shares no code with the web prototype and reads only /api/v1/*.
//   node ui-next/prototype-terminal/foreman-tui.mjs [--once] [--url http://127.0.0.1:8732]
// Node 18 or later (global fetch). No dependencies.
const args = process.argv.slice(2);
const once = args.includes('--once');
const base = (args[args.indexOf('--url') + 1] && args.includes('--url') ? args[args.indexOf('--url') + 1] : process.env.FOREMAN_URL || 'http://127.0.0.1:8732').replace(/\/$/, '');
const API = `${base}/api/v1`;
const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text);
const TONE = { fault: ['31;1', '▲'], you: ['35;1', '◆'], unknown: ['90', '◌'], active: ['32', '●'], waiting: ['37', '○'], held: ['33', '‖'], done: ['90', '■'], off: ['90', '–'] };

// Formatting is the client's job: London time, percentages, durations.
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
const dur = s => { if (s == null) return 'unknown'; const m = Math.floor(s / 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const pct = w => (w.state === 'known' ? `${Math.round(w.used_fraction * 100)}%` : '?');
const words = s => String(s || 'unknown').replace(/_/g, ' ');

let groups = {};
const toneOf = c => (c.attention === 'fault' ? 'fault' : c.attention === 'homeowner' ? 'you' : c.attention === 'unknown' ? 'unknown' : ({ failed: 'fault' }[groups[c.state]] || groups[c.state] || 'waiting'));
const mark = (c, text) => { const [code, glyph] = TONE[toneOf(c)] || TONE.waiting; return paint(code, `${glyph} ${text ?? words(c.state)}`); };

async function get(path) {
  const r = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  const model = await r.json();
  if (!/^1\./.test(model.contract || '')) throw new Error(`${path} speaks contract ${model.contract}; this client needs 1.x`);
  return model;
}

function appBarLine(bar) {
  const d = bar.data;
  const agents = d.agents.map(a => {
    const stale = a.reading.stale ? paint('90', ` (${dur(a.reading.age_seconds)} old)`) : '';
    return `${mark(a.condition, a.display_name)} ${pct(a.weekly)} wk · ${pct(a.short)} 5h${stale}`;
  });
  const since = d.system.since && d.system.attention !== 'none' ? ` ${dur(Math.round((Date.parse(bar.generated_at) - Date.parse(d.system.since)) / 1000))}` : '';
  return [paint('1', 'Foreman'), mark(d.system, words(d.system.state) + since), ...agents, `slots ${d.slots.in_use}/${d.slots.max}`,
    paint('35', `needs you ${d.counts.needs_you}`), paint('31', `faults ${d.counts.faults}`), `tick ${d.tick.state}${d.tick.next_at ? ' ' + clock.format(new Date(d.tick.next_at)) : ''}`].join('  │  ');
}

function stalledBanner(overview) {
  const d = overview.data;
  if (!d.stalls.length) return [paint('32', '● Working: nothing is stalled.')];
  const lines = [paint('41;97;1', ' STALLED '), paint('31;1', d.verdict.reason_text)];
  for (const s of d.stalls) {
    lines.push('', `${mark(s.condition, s.agent)} idle for ${dur(s.idle_seconds)}: ${s.condition.reason_code === 'unrecorded' ? paint('31;1', 'no reason recorded') : words(s.condition.reason_code)}`);
    lines.push(`  ${s.condition.reason_text}`);
    for (const p of s.planned) lines.push(`  - ${words(p.type)} ${p.target.label}: ${p.condition.reason_text}${p.held_by ? ` Held by ${p.held_by.label}.` : ''}`);
    const usable = s.actions.filter(a => a.enabled).map(a => `${a.command} ${JSON.stringify(a.input)}`);
    if (usable.length) lines.push(paint('90', `  controls: ${usable.join('  |  ')}`));
  }
  return lines;
}

async function draw(live) {
  const [bar, overview] = await Promise.all([get('/appbar'), get('/overview')]);
  const out = [];
  if (!once && colour) out.push('\x1b[2J\x1b[H');
  out.push(appBarLine(bar), '');
  if (bar.freshness.state !== 'fresh') out.push(paint('90', `◌ Data is stale: last tick ${clock.format(new Date(bar.freshness.tick_at))} (${dur(bar.freshness.age_seconds)} ago). ${bar.freshness.reason_text || ''}`), '');
  out.push(...stalledBanner(overview), '');
  out.push(paint('90', `contract ${bar.contract} · ${base} · ${live} · times Europe/London${once ? '' : ' · Ctrl+C to quit'}`));
  process.stdout.write(out.join('\n') + '\n');
}

// The event stream: redraw when the core says the app bar or the overview changed; say so when the stream is lost.
async function follow() {
  let last = null;
  for (;;) {
    try {
      const r = await fetch(`${API}/events`, { headers: { accept: 'text/event-stream', ...(last ? { 'last-event-id': last } : {}) } });
      if (!r.ok || !r.body) throw new Error(`event stream answered ${r.status}`);
      await draw('live');
      const decoder = new TextDecoder(); let text = '';
      for await (const chunk of r.body) {
        text += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = text.indexOf('\n\n')) >= 0) {
          const block = text.slice(0, cut); text = text.slice(cut + 2);
          const id = /^id: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (id) last = id;
          if (!data) continue;
          const event = JSON.parse(data);
          const touched = event.type === 'resync_required' || event.type === 'freshness_changed' || (event.models || []).some(m => m === 'appbar' || m === 'overview');
          if (touched) await draw('live');
        }
      }
      throw new Error('event stream closed');
    } catch (error) {
      try { await draw(`reconnecting (${error.message})`); } catch { process.stdout.write(paint('31;1', `▲ Foreman cannot be reached at ${base}: ${error.message}. Showing nothing rather than old data.\n`)); }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

try {
  groups = Object.fromEntries((await get('/meta')).data.states.map(s => [s.state, s.group]));
  if (once) await draw('one reading');
  else await follow();
} catch (error) {
  process.stderr.write(`Foreman terminal client: ${error.message}\n`);
  process.exitCode = 1;
}
