// Home Assistant read-only browser profile (issue #10, D-008, D-009, D-022). Pure helpers: no browser, no filesystem, so they are
// unit-tested directly. The container wrapper (ha-readonly.mjs) applies them; the host-side live gate (ha-live-gate.mjs) decides
// whether a run against the real Home Assistant may even start. Nothing here logs in to anything.

// The pages the issue names, as a page set: `live` is the Lovelace paths on the real instance, `fixture` the anonymised local copies.
export const PAGE_SETS = {
  live: [
    { name: 'dashboard', path: '/lovelace/0' },
    { name: 'heating-settings', path: '/lovelace/heating-settings' },
    { name: 'heating-season', path: '/lovelace/heating-season' }
  ],
  fixture: [
    { name: 'dashboard', path: '/dashboard.html' },
    { name: 'heating-settings', path: '/heating-settings.html' },
    { name: 'heating-season', path: '/heating-season.html' }
  ]
};
// Phone portrait plus desktop, the two views the issue asks for (profiles defined in capture.mjs).
export const HA_PROFILES = ['phone-390', 'desktop-1280'];
export const PROBE_MODES = ['none', 'clicks'];

// ---------- network: only reads ----------
const READ_METHODS = new Set(['GET', 'HEAD']);
export const isReadOnlyMethod = (method) => READ_METHODS.has(String(method).toUpperCase());

// Home Assistant's frontend talks over one WebSocket. Only these message types read state or keep the socket alive; everything
// else (call_service, config/*/update, lovelace/config/save, input_*/set_value, ...) is a possible write and is refused. An
// allow-list, so an unknown or future type is refused too.
export const WS_READ_TYPES = new Set([
  'auth', 'ping', 'pong', 'get_states', 'get_config', 'get_services', 'get_panels', 'subscribe_events', 'unsubscribe_events',
  'subscribe_entities', 'lovelace/config', 'lovelace/resources', 'frontend/get_themes', 'frontend/get_user_data', 'auth/current_user',
  'config/entity_registry/list', 'config/device_registry/list', 'config/area_registry/list'
]);
// Returns { allow, type }. `type` is a sanitised structural label only: a payload (entity ids, values, tokens) is never returned.
export function wsFrameDecision(frame) {
  let msg;
  try { msg = JSON.parse(typeof frame === 'string' ? frame : Buffer.from(frame).toString('utf8')); } catch { return { allow: false, type: 'non-json' }; }
  const type = msg && typeof msg === 'object' && !Array.isArray(msg) && typeof msg.type === 'string' ? msg.type : null;
  if (!type || !/^[a-z0-9_/]{1,64}$/.test(type)) return { allow: false, type: 'invalid' };
  return { allow: WS_READ_TYPES.has(type), type };
}

// ---------- page: no state-changing interaction ----------
// Elements that can change Home Assistant state, climate and helper (input_*) entities included. Matched against every element on
// the event's composed path, so shadow DOM (the whole HA frontend) is covered.
export const MUTATING_SELECTOR = [
  'button', 'input', 'select', 'textarea', 'form', 'summary',
  '[role=switch]', '[role=slider]', '[role=button]', '[role=checkbox]', '[role=spinbutton]', '[role=combobox]', '[contenteditable]',
  '[data-service]', '[data-domain]', '[data-action]',
  'ha-switch', 'ha-slider', 'ha-select', 'ha-textfield', 'ha-entity-toggle', 'ha-icon-button', 'ha-button', 'mwc-button', 'mwc-switch',
  'ha-climate-control', 'ha-more-info-climate-temperature', 'hui-climate-entity-row', 'hui-input-number-entity-row', 'hui-input-select-entity-row',
  'hui-input-text-entity-row', 'hui-input-datetime-entity-row', 'hui-toggle-entity-row'
].join(',');
// Plain navigation only: a link or a tab. A control that is both a tab and a button is navigation.
export const NAVIGATION_SELECTOR = 'a[href], [role=tab], [data-ha-nav]';
export const GUARDED_EVENTS = ['click', 'dblclick', 'auxclick', 'contextmenu', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'input', 'change', 'submit', 'wheel'];

// Runs INSIDE every page (page.addInitScript), so it must be self-contained. It installs capture-phase listeners on window that stop
// a state-changing interaction before the page sees it, and counts them in window.__haBlockedInteractions (type labels only).
export function installInteractionGuard(options) {
  const { mutating, navigation, events } = options;
  const blocked = (window.__haBlockedInteractions = window.__haBlockedInteractions || []);
  const nearest = (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (!node || node.nodeType !== 1 || typeof node.matches !== 'function') continue;
      const nav = node.matches(navigation);
      const mut = node.matches(mutating);
      if (nav) return { mutates: false };
      if (mut) return { mutates: true, tag: String(node.tagName).toLowerCase() };
    }
    return { mutates: false };
  };
  const handler = (event) => {
    const r = nearest(event);
    if (!r.mutates) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (blocked.length < 200) blocked.push(`${event.type}:${/^[a-z][a-z0-9-]{0,40}$/.test(r.tag) ? r.tag : 'other'}`);
  };
  for (const name of events) window.addEventListener(name, handler, { capture: true });
}

// ---------- report ----------
export function haOutcome({ pages, blockedWrites, blockedFrames, blockedInteractions, probe }) {
  const readonlyViolations = blockedWrites.length + blockedFrames.length;
  // Interactions blocked while the wrapper itself was NOT probing mean the page tried to act on its own: a finding.
  const unexpected = probe && probe.mode === 'clicks' ? 0 : blockedInteractions.length;
  const bypassed = probe && probe.mode === 'clicks' ? probe.mutated : 0;
  const layoutOk = pages.every((p) => p.ok);
  return { readonlyViolations, unexpectedInteractions: unexpected, probeBypassed: bypassed, layoutOk,
    ok: layoutOk && readonlyViolations === 0 && unexpected === 0 && bypassed === 0 };
}

export function renderHaReport(summary) {
  const lines = [`# Home Assistant read-only browser test (${summary.pageSet}, ${summary.browser})`, '',
    `Result: **${summary.ok ? 'PASS' : 'FAIL'}**. Mode: ${summary.pageSet === 'fixture' ? 'anonymised local fixture; **not the live Home Assistant**' : 'live'}.`, '',
    `> Scope: ${summary.scope}`, '',
    '| Page | Profile | Viewport | Rendered | Layout failures | Warnings |', '|---|---|---|---|---|---|'];
  for (const page of summary.pages) for (const p of page.profiles)
    lines.push(`| ${page.page} | ${p.profile} | ${p.viewport.width}x${p.viewport.height} | ${p.rendered ? 'yes' : '**no**'} | ${p.failures} | ${p.warnings} |`);
  const fails = summary.pages.flatMap((p) => p.failures.map((f) => ({ page: p.page, ...f })));
  if (fails.length) { lines.push('', '## Layout failures'); for (const f of fails) lines.push(`- ${f.page} / ${f.profile}: \`${f.check}\` on \`${f.element}\``); }
  lines.push('', '## Read-only enforcement',
    `- Non-GET/HEAD requests blocked: ${summary.readOnly.blockedWrites.length}`,
    `- WebSocket frames blocked (not on the read allow-list): ${summary.readOnly.blockedFrames.length}`,
    `- State-changing interactions blocked in the page: ${summary.readOnly.blockedInteractions.length}`);
  if (summary.probe && summary.probe.mode === 'clicks') lines.push(`- Click probe: ${summary.probe.attempted} control(s) clicked, ${summary.probe.blocked} blocked, **${summary.probe.mutated} changed state**`);
  lines.push('', `Screenshots: ${summary.pages.reduce((n, p) => n + p.profiles.filter((x) => x.screenshot).length, 0)} saved next to this report.`);
  return `${lines.join('\n')}\n`;
}
