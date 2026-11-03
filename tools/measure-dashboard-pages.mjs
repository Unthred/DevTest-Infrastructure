// Issue #467: page-time measurement, the same method before and after. Usage:
//   node tools/measure-dashboard-pages.mjs <base-url> [samples=21] [gap-ms=0] [concurrency=1]
// For each fixed page, makes `samples` GET requests in rounds of `concurrency` simultaneous requests (default 1: one after another),
// waiting `gap-ms` between rounds, and prints median / mean / worst in ms. Run it against the local address and the public address,
// with the full test suite running, before and after a change; use the same arguments each time. Reads pages only.
const [base, n = '21', gap = '0', conc = '1'] = process.argv.slice(2);
if (!base) { console.error('usage: measure-dashboard-pages.mjs <base-url> [samples] [gap-ms] [concurrency]'); process.exit(2); }
const PAGES = ['/', '/timeline', '/api/view.json'], samples = Number(n), wait = Number(gap), width = Math.max(1, Number(conc));
const stats = xs => { const s = [...xs].sort((a, b) => a - b); return { median: s[Math.floor(s.length / 2)], mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), worst: s.at(-1) }; };
const one = async page => {
  const t = performance.now(); let bad = 0;
  try { const r = await fetch(new URL(page, base)); await r.arrayBuffer(); if (r.status !== 200) bad = 1; } catch { bad = 1; }
  return { ms: Math.round(performance.now() - t), bad };
};
for (const page of PAGES) {
  const times = []; let bad = 0;
  for (let done = 0; done < samples; done += width) {
    const round = await Promise.all(Array.from({ length: Math.min(width, samples - done) }, () => one(page)));
    for (const r of round) { times.push(r.ms); bad += r.bad; }
    if (wait) await new Promise(r => setTimeout(r, wait));
  }
  console.log(`${page} samples=${times.length} concurrency=${width} non200=${bad} ${JSON.stringify(stats(times))}`);
}
