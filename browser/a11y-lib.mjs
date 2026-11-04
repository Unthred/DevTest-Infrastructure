// Pure helpers for the accessibility scan (issue #455): no browser, no filesystem, so they are unit-tested directly.
// The scan runs axe-core in a page inside the network-less browser container. axe finds only a part of the accessibility problems
// a page can have; the report says so on every run and a pass is never described as "accessible".
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
export const AXE_LIMIT = 'Automated checks (axe-core, WCAG 2.1 A and AA rules) find only some accessibility problems. A pass does not show the page is accessible: keyboard use, focus order, meaning of labels, colour use, motion and contrast in both themes still need a person.';

// Runs INSIDE the page via page.evaluate, after axe.min.js was injected, so it must be self-contained. Nothing the page controls except
// markup structure may reach the artifacts (D-008): a node is named by tag names and child positions only (as layout-check.mjs does),
// never by id, class, text or axe's html snippet.
export async function runAxeInPage(tags) {
  const TAGS = new Set('a article aside body button details dialog div footer form h1 h2 h3 h4 h5 h6 header iframe img input label li main nav ol option p section select span summary svg table tbody td textarea th thead tr ul video'.split(' '));
  const label = (el) => {
    const parts = [];
    for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 6; n = n.parentElement, depth++) {
      const tag = String(n.tagName).toLowerCase();
      parts.unshift(`${TAGS.has(tag) ? tag : 'other'}${n.parentElement ? `[${Array.prototype.indexOf.call(n.parentElement.children, n)}]` : ''}`);
    }
    return parts.join('>');
  };
  const nodeLabel = (target) => { try { const el = typeof target[0] === 'string' && target.length === 1 ? document.querySelector(target[0]) : null; return el ? label(el) : 'in-frame-or-shadow'; } catch { return 'unresolved'; } };
  const res = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'] });
  const shape = (list) => list.map((r) => ({ id: String(r.id), impact: r.impact ?? null, help: String(r.help), helpUrl: String(r.helpUrl), tags: r.tags.filter((t) => /^(wcag|best)/.test(t)),
    nodes: r.nodes.slice(0, 20).map((n) => nodeLabel(n.target)), nodeCount: r.nodes.length }));
  return { axeVersion: window.axe.version, violations: shape(res.violations), incomplete: shape(res.incomplete) };
}

const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const byImpact = (a, b) => (IMPACT_ORDER[a.impact] ?? 4) - (IMPACT_ORDER[b.impact] ?? 4) || a.id.localeCompare(b.id);

export function summarise({ target, path, browser, name, results }) {
  const profiles = results.map((r) => ({ profile: r.name, viewport: r.profile.viewport, scanned: !!r.axe, violations: r.axe ? r.axe.violations.sort(byImpact) : [], incomplete: r.axe ? r.axe.incomplete.sort(byImpact) : [] }));
  const count = (key) => profiles.reduce((n, p) => n + p[key].reduce((m, v) => m + v.nodeCount, 0), 0);
  const axeVersion = results.find((r) => r.axe)?.axe.axeVersion ?? null;
  return { schema_version: 1, target, path: String(path).replace(/[?#].*$/s, ''), browser, name, axe_version: axeVersion, tags: AXE_TAGS,
    ok: profiles.length > 0 && profiles.every((p) => p.scanned && p.violations.length === 0),
    violation_nodes: count('violations'), incomplete_nodes: count('incomplete'), limitation: AXE_LIMIT, profiles };
}

export function renderReport(summary) {
  const lines = [`# Accessibility scan: ${summary.path} (${summary.browser}, axe-core ${summary.axe_version ?? 'unknown'})`, '',
    `Result: **${summary.ok ? 'NO AUTOMATED VIOLATIONS' : 'VIOLATIONS FOUND'}** against ${summary.tags.join(', ')} across ${summary.profiles.length} profile(s).`,
    '', `> ${summary.limitation}`, '', `Violations: ${summary.violation_nodes} element(s). Incomplete (axe could not decide; a person must check): ${summary.incomplete_nodes} element(s).`];
  for (const p of summary.profiles) {
    lines.push('', `## ${p.profile} (${p.viewport.width}x${p.viewport.height})`);
    if (!p.scanned) { lines.push('Not scanned: the page did not load.'); continue; }
    for (const [title, list] of [['Violations', p.violations], ['Incomplete: needs a person', p.incomplete]]) {
      lines.push('', `### ${title}`);
      if (!list.length) { lines.push('None.'); continue; }
      for (const v of list) lines.push(`- \`${v.id}\` (${v.impact ?? 'n/a'}): ${v.help}. ${v.nodeCount} element(s), e.g. \`${v.nodes[0] ?? ''}\``);
    }
  }
  return `${lines.join('\n')}\n`;
}
