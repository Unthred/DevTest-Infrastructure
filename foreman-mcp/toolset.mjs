// The tools the server offers: the read tools and foreman_propose (tools.mjs) plus the overseer control tools of issue #1115 (controltools.mjs),
// and the control records added to the answers of foreman_why_blocked and foreman_jobs. Control tools keep their own call budget.
import { createTools, CALLS_PER_MINUTE, MAX_TEXT } from './tools.mjs';
import { controlTools } from './controltools.mjs';
import { withControls } from './controlview.mjs';
import { redact } from './redact.mjs';
import { STALE_TEXT, markStale, markStatus } from './selfcheck.mjs';
import { stopRecordTool, viewReasons, DEFAULT_STOP_DIRS } from './stoprecord.mjs';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Tools that write a proposal: refused while the server is stale (issue #1314).
const WRITERS = new Set(['foreman_propose', 'foreman_park', 'foreman_stop_job', 'foreman_unpark', 'foreman_release_agent', 'foreman_withdraw']);
const WITH_CONTROLS = new Set(['foreman_why_blocked', 'foreman_jobs']);

export function createToolset(options) {
  const base = createTools(options), now = options.now ?? Date.now, calls = [];
  const stop = stopRecordTool({ reasons: viewReasons({ source: options.source, getPath: options.getPath }), dirs: options.stopDirs ?? DEFAULT_STOP_DIRS, redact });   // issue #1161
  const extra = [stop, ...(options.inbox?.enabled ? controlTools({ inbox: options.inbox, waitMs: options.controlWaitMs ?? 20000 }) : [])];
  const own = name => extra.find(d => d.name === name);
  return {
    list: () => [...base.list(), ...extra.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations: annotations || READ_ONLY }))],
    has: name => base.has(name) || !!own(name),
    async call(name, args = {}) {
      const check = options.selfCheck, stale = check ? check.stale() : false;
      if (stale && WRITERS.has(name)) return { isError: true, text: markStale(JSON.stringify({ error: STALE_TEXT })) };
      const out = await answer(name, args);
      if (!check) return out;
      const text = name === 'foreman_status' && !out.isError ? markStatus(out.text, check, stale) : out.text;
      return { ...out, text: stale ? markStale(text) : text };
    },
  };
  async function answer(name, args) {
    const def = own(name);
    if (!def) {
      const out = await base.call(name, args);
      if (out.isError || !WITH_CONTROLS.has(name)) return out;
      const view = await options.source.get().then(r => r.view, () => null);
      return { ...out, text: withControls(name, args, out.text, view?.controls).slice(0, MAX_TEXT + 4000) };
    }
    const t = now(); while (calls.length && t - calls[0] > 60000) calls.shift();
    if (calls.length >= CALLS_PER_MINUTE) return { isError: true, text: `rate limit: more than ${CALLS_PER_MINUTE} calls in a minute; try again shortly` };
    calls.push(t);
    try { return { isError: false, text: redact(JSON.stringify(await def.run(args && typeof args === 'object' ? args : {}), null, 1)).slice(0, MAX_TEXT) }; }
    catch (error) { return { isError: true, text: redact(JSON.stringify({ error: String(error?.message || error).slice(0, 400) })) }; }
  }
}
