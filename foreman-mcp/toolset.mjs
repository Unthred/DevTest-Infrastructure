// The tools the server offers: the read tools and foreman_propose (tools.mjs) plus the overseer control tools of issue #1115 (controltools.mjs),
// and the control records added to the answers of foreman_why_blocked and foreman_jobs. Control tools keep their own call budget.
import { createTools, CALLS_PER_MINUTE, MAX_TEXT } from './tools.mjs';
import { controlTools } from './controltools.mjs';
import { inboxFailureTools } from './inboxfailures.mjs';
import { withControls } from './controlview.mjs';
import { redact } from './redact.mjs';

const WITH_CONTROLS = new Set(['foreman_why_blocked', 'foreman_jobs']);

// Issue #1154: foreman_propose also accepts `resolves` and `resolution` (checked in inbox.mjs).
const RESOLVE_PROPERTIES = {
  resolves: { type: 'string', pattern: '^([a-f0-9]{8}|[a-f0-9]{32})$', description: 'optional: the failed Inbox item (from foreman_inbox_failures) this proposal re-proposes or supersedes' },
  resolution: { type: 'string', enum: ['re-proposed', 'superseded'], description: 'with resolves: how (default re-proposed)' },
};
const withResolveProperties = def => (def.name === 'foreman_propose' ? { ...def, inputSchema: { ...def.inputSchema, properties: { ...def.inputSchema.properties, ...RESOLVE_PROPERTIES } } } : def);

export function createToolset(options) {
  const base = createTools(options), now = options.now ?? Date.now, calls = [];
  const extra = options.inbox?.enabled ? [...controlTools({ inbox: options.inbox, waitMs: options.controlWaitMs ?? 20000 }), ...inboxFailureTools({ inbox: options.inbox })] : [];
  const own = name => extra.find(d => d.name === name);
  return {
    list: () => [...base.list().map(withResolveProperties), ...extra.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }))],
    has: name => base.has(name) || !!own(name),
    async call(name, args = {}) {
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
    },
  };
}
