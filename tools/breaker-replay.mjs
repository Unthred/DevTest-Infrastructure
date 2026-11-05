#!/usr/bin/env node
// Issue #549: replay the supervisor's finished job records through the circuit breaker. Read-only: it reads jobs/ and team/state.json under
// the state root and prints when the breaker would have tripped and the usage it would have saved. No GitHub, no model, nothing written.
// usage: node tools/breaker-replay.mjs --from 2026-11-03T07:50:00Z --to 2026-11-04T13:50:00Z [--root DIR] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { replay, COST_LABEL, trippedByLabel } from '../supervisor/breaker.mjs';
import { readJobs } from '../supervisor/dashdata.mjs';

const argv = process.argv.slice(2), args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const next = argv[i + 1]; args[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : next; }
const root = args.root || process.env.AI_SUPERVISOR_STATE_ROOT || '/mnt/cache/ai-supervisor';
const from = args.from ? Date.parse(args.from) : 0, to = args.to ? Date.parse(args.to) : Infinity;
let state = {}; try { state = JSON.parse(fs.readFileSync(path.join(root, 'team', 'state.json'), 'utf8')); } catch { /* no team state: job records only */ }
const verdictJobs = new Set([state.verdicts, state.secondOpinions, state.exceptionReviews].flatMap(m => Object.values(m || {})).map(v => v?.job).filter(Boolean));
const out = replay({ jobs: readJobs(root), entries: state.jobs || {}, verdictJobs, from, to });
if (args.json === true) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
const iso = t => new Date(t).toISOString().slice(0, 16) + 'Z', usd = n => `$${n.toFixed(2)}`;
console.log(`Wasted jobs in range: ${out.wasted.jobs}, ${out.wasted.tokens.toLocaleString('en-GB')} tokens (${out.wasted.inputTokens.toLocaleString('en-GB')} in, ${out.wasted.outputTokens.toLocaleString('en-GB')} out), ${usd(out.wasted.cost)} ${COST_LABEL}`);
for (const c of out.byCause) console.log(`  ${c.cause}: ${c.jobs} jobs, ${usd(c.cost)}`);
if (!out.trips.length) console.log('The breaker would not have tripped.');
for (const t of out.trips) console.log(`Would trip ${t.scope === '@global' ? 'GLOBAL (all new jobs)' : t.scope} at ${iso(t.at)} (${trippedByLabel(t.trippedBy)}); would have prevented ${t.jobsPrevented} later wasted jobs, saving ${t.tokensSaved.toLocaleString('en-GB')} tokens and ${usd(t.costSaved)}`);
