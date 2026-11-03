// Issue #467: page-time measurement, the same method before and after. Usage:
//   node tools/measure-dashboard-pages.mjs <base-url> [samples=21] [gap-ms=0]
// Fetches the same fixed pages `samples` times each (GET only) and prints median / mean / worst in ms. Run it once against the local address
// and once against the public address, with the full test suite running, before and after a change. Reads pages only.
const [base, n = '21', gap = '0'] = process.argv.slice(2);
if (!base) { console.error('usage: measure-dashboard-pages.mjs <base-url> [samples] [gap-ms]'); process.exit(2); }
const PAGES = ['/', '/timeline', '/api/view.json'], samples = Number(n), wait = Number(gap);
const stats = xs => { const s = [...xs].sort((a, b) => a - b); return { median: s[Math.floor(s.length / 2)], mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), worst: s.at(-1) }; };
for (const page of PAGES) {
  const times = []; let bad = 0;
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    try { const r = await fetch(new URL(page, base)); await r.arrayBuffer(); if (r.status !== 200) bad++; } catch { bad++; }
    times.push(Math.round(performance.now() - t));
    if (wait) await new Promise(r => setTimeout(r, wait));
  }
  console.log(`${page} samples=${samples} non200=${bad} ${JSON.stringify(stats(times))}`);
}
