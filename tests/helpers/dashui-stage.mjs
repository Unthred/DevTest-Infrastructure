// Shared by tests/dashboard-visual.mjs and its test (issue #455). Two jobs the old script did by hand and got wrong (it staged four of
// the five scripts and missed legend.mjs): stage EVERY file the dashboard serves, and derive the page list from the routes so no
// dashboard route is left out. Pure functions plus one copy step; no browser, no Docker.
import fs from 'node:fs';
import path from 'node:path';
import { STATIC } from '../../supervisor/dashserver.mjs';
import { NAV, matchRoute } from '../../supervisor/dashrender.mjs';
import { readTranscript } from '../../supervisor/transcript.mjs';
import { listRuns, readRun } from '../../supervisor/evidence.mjs';

const dashui = new URL('../../supervisor/dashui/', import.meta.url).pathname;

// Copies every served static file to <dest>/static/<name>. Returns the URL paths staged.
export function stageDashui(dest, srcDir = dashui) {
  fs.mkdirSync(path.join(dest, 'static'), { recursive: true });
  return Object.entries(STATIC).map(([url, [file]]) => { fs.copyFileSync(path.join(srcDir, file), path.join(dest, 'static', file)); return url; }).sort();
}

// /static/... URLs a page loads (script, stylesheet, module preload).
export const refsInHtml = html => [...String(html).matchAll(/\b(?:src|href)="(\/static\/[^"#?]+)"/g)].map(m => m[1]);
// /static/... URLs a script loads: static `from './x.mjs'`, side-effect `import './x.mjs'` and dynamic `import('./x.mjs')`, plus absolute /static paths.
export function refsInModule(source) {
  const out = [];
  for (const m of String(source).matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('/static/')) out.push(spec); else if (spec.startsWith('./')) out.push(`/static/${spec.slice(2)}`);
  }
  return out;
}
// Everything a set of rendered pages loads, following scripts' own imports. `read(url)` returns a script's source (or null).
export function loadedFiles(htmls, read) {
  const seen = new Set(), queue = htmls.flatMap(refsInHtml);
  while (queue.length) { const u = queue.pop(); if (seen.has(u)) continue; seen.add(u); if (/\.m?js$/.test(u)) { const src = read(u); if (src != null) queue.push(...refsInModule(src)); } }
  return [...seen].sort();
}
export const readServed = (url, srcDir = dashui) => { const e = STATIC[url]; return e ? fs.readFileSync(path.join(srcDir, e[0]), 'utf8') : null; };

// Lower case, because the browser wrapper only accepts simple lower-case file names (capture.mjs --name).
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
// One entry per dashboard route that the view (and the evidence folder) can fill: { name, path, route, data? }. `name` is what the
// script's page argument selects. Detail routes use the first item the view has.
export function pagePlan(view, { root, evidenceRoot } = {}) {
  const entries = NAV.map(([page, href]) => ({ name: page, path: href }));
  entries.push({ name: 'timeline', path: '/activity/timeline' }, { name: 'ticks', path: '/supervisor/ticks' }, { name: 'upgrades', path: '/supervisor/upgrades' }, { name: 'evidence', path: '/evidence' });
  const first = obj => Object.keys(obj || {})[0];
  const agent = (view.agents || [])[0]?.name, pr = first(view.refs?.pr), issue = first(view.refs?.issue), jobKey = first(view.refs?.job), watch = (view.jobs || []).find(j => j.fullId)?.fullId;
  if (agent) entries.push({ name: `agent-${slug(agent)}`, path: `/agents/${agent}` });
  if (pr) entries.push({ name: `pr-${slug(pr)}`, path: `/work/pr/${pr}` });
  if (issue) entries.push({ name: `issue-${slug(issue)}`, path: `/work/issue/${issue}` });
  if (jobKey) entries.push({ name: `job-${slug(jobKey)}`, path: `/work/job/${jobKey}` });
  if (watch && root) entries.push({ name: 'watch', path: `/jobs/${watch}` });
  const run = evidenceRoot ? listRuns(evidenceRoot).runs[0]?.name : null;
  if (run) entries.push({ name: 'evidence-run', path: `/evidence/${run}` });
  return entries.map(e => {
    const route = matchRoute(e.path);
    const data = route.page === 'evidence-run' ? readRun(evidenceRoot, route.id) : null;
    const extra = route.page === 'watch' ? { transcript: readTranscript(root, route.id), job: (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'jobs', `${route.id}.json`), 'utf8')); } catch { return null; } })(), runningNow: view.generatedAt } : route.page === 'evidence' ? { data: listRuns(evidenceRoot || '/nonexistent') } : data ? { data } : {};
    return { ...e, route: { ...route, ...extra } };
  });
}

// "overview,work" -> the matching entries; an unknown name is an error that lists the choices. No argument selects every page.
export function selectPages(plan, arg) {
  if (!arg) return plan;
  const names = String(arg).split(',').map(s => s.trim()).filter(Boolean), have = new Map(plan.map(e => [e.name, e]));
  const unknown = names.filter(n => !have.has(n));
  if (unknown.length || !names.length) throw new Error(`unknown page(s) ${unknown.join(', ') || '(none given)'}; available: ${plan.map(e => e.name).join(', ')}`);
  return [...new Set(names)].map(n => have.get(n));
}
