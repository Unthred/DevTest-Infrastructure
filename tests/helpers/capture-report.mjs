// Issue #502: a capture that exits 10 ("problems") used to say only "exit 10". The wrapper writes <name>-<profile>-<browser>.report.json
// next to the screenshot (already URL-redacted), so the harness now names what the page reported: failed requests, HTTP errors, console
// and page errors. Pure and bounded; a missing or unreadable report adds nothing.
import fs from 'node:fs';
import path from 'node:path';

export function summarizeReport(report, limit = 5) {
  if (!report || typeof report !== 'object') return '';
  const clip = v => String(v ?? '').replace(/\s+/g, ' ').slice(0, 160);
  const part = (label, list, show) => Array.isArray(list) && list.length ? [`${label}: ${list.slice(0, limit).map(show).join('; ')}${list.length > limit ? ` (+${list.length - limit} more)` : ''}`] : [];
  return [
    ...part('problems', report.problems, clip),
    ...part('httpErrors', report.httpErrors, e => `${clip(e?.status)} ${clip(e?.url)}`),
    ...part('failedRequests', report.failedRequests, e => `${clip(e?.url)} ${clip(e?.error)}`.trim()),
    ...part('consoleErrors', report.consoleErrors, clip),
    ...part('pageErrors', report.pageErrors, clip),
  ].join(' | ');
}

// Reads every *.report.json in a run's out directory and returns "\n    <file>: <summary>" lines (empty string when there is nothing to say).
export function reportSummary(outDir) {
  let names; try { names = fs.readdirSync(outDir).filter(f => f.endsWith('.report.json')).sort(); } catch { return ''; }
  const lines = [];
  for (const f of names) { let r; try { r = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')); } catch { continue; } const s = summarizeReport(r); if (s) lines.push(`\n    ${f}: ${s}`); }
  return lines.join('');
}
