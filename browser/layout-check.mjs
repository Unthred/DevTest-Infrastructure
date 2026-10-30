// Runs INSIDE the page via page.evaluate, so it must be self-contained (no imports, no closures over module state).
// Returns findings { check, severity: 'fail' | 'warn', element, ...detail }. Page text, input values and aria-labels are never copied out (D-008). See responsive-lib.mjs CHECKS for the meanings.
export function layoutCheck(options) {
  const tol = 1, minTarget = 24, comfortable = 44;
  const doc = document.documentElement, vw = doc.clientWidth;
  const findings = [];
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : ''}`;
  const shown = (el) => { const r = el.getBoundingClientRect(), c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none' && c.opacity !== '0'; };
  const add = (check, severity, el, detail = {}) => findings.push({ check, severity, element: label(el), ...detail });
  const scroller = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return p; } return null; };

  if (doc.scrollWidth > doc.clientWidth + tol) add('document-overflow', 'fail', document.body, { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth });

  const elements = [...document.body.querySelectorAll('*')].filter(shown);
  const beyond = new Set();
  for (const el of elements) {
    const r = el.getBoundingClientRect();
    if ((r.right > vw + tol || r.left < -tol) && !scroller(el) && getComputedStyle(el).position !== 'fixed') beyond.add(el);
  }
  for (const el of beyond) if (!beyond.has(el.parentElement)) add('beyond-viewport', 'fail', el, { left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right), viewport: vw });

  const controls = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'IMG']);
  for (const el of elements) {
    const c = getComputedStyle(el);
    if ((c.overflowX === 'hidden' || c.overflowX === 'clip') && el.scrollWidth > el.clientWidth + tol)
      add(c.textOverflow === 'ellipsis' ? 'truncated' : 'clipped', c.textOverflow === 'ellipsis' ? 'warn' : 'fail', el, { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    const p = el.parentElement;
    if (p && p !== document.body && (controls.has(el.tagName) || el.hasAttribute('data-ui')) && !beyond.has(el)) {
      const pc = getComputedStyle(p);
      if (pc.overflowX === 'visible' && el.getBoundingClientRect().right > p.getBoundingClientRect().right + tol) add('escapes-parent', 'fail', el, { overshoot: Math.round(el.getBoundingClientRect().right - p.getBoundingClientRect().right) });
    }
  }

  const touch = !!options.touch;
  const targets = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [tabindex]:not([tabindex="-1"])')].filter(shown);
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    if ((r.left < -tol || r.right > vw + tol) && !scroller(el)) add('target-offscreen', 'fail', el, { left: Math.round(r.left), right: Math.round(r.right), viewport: vw });
    const smallest = Math.min(r.width, r.height);
    if (smallest < minTarget) add('target-too-small', 'fail', el, { width: Math.round(r.width), height: Math.round(r.height) });
    else if (touch && smallest < comfortable) add('target-below-44', 'warn', el, { width: Math.round(r.width), height: Math.round(r.height) });
  }
  for (const el of targets) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect(), x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1), y = r.top + r.height / 2;
    if (y < 0 || y >= innerHeight) continue;
    const top = document.elementFromPoint(x, y);
    if (top && top !== el && !el.contains(top) && !top.contains(el) && !(el.closest('label') && el.closest('label').contains(top))) add('target-covered', 'fail', el, { coveredBy: label(top) });
  }
  scrollTo(0, 0);

  for (const row of document.querySelectorAll('[data-chips]')) {
    if (!shown(row)) continue;
    const tops = [...new Set([...row.children].filter(shown).map((c) => Math.round(c.getBoundingClientRect().top / 4)))];
    if (row.getAttribute('data-chips') !== 'wrap' && tops.length > 1) add('chips-wrapped', 'fail', row, { rows: tops.length });
  }
  return findings;
}
