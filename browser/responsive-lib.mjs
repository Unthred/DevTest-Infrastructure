// Pure helpers for the responsive audit (issue #6): no browser, no filesystem, so they are unit-tested directly.
export const CHECKS = {
  'document-overflow': 'The page scrolls sideways (document wider than the viewport).',
  'beyond-viewport': 'An element extends past the viewport edge outside any scroll container.',
  clipped: 'Content is cut off by an overflow:hidden/clip box with no ellipsis.',
  'escapes-parent': 'A control or card sticks out of its parent box.',
  'target-offscreen': 'A tap/click target is outside the viewport horizontally.',
  'target-too-small': 'A target is smaller than 24x24 CSS px (WCAG 2.2 2.5.8).',
  'target-covered': 'Another element sits on top of the centre of a target.',
  'chips-wrapped': 'A chip row declared single-line wrapped onto several lines.',
  truncated: 'Text is shortened with an ellipsis (warning only).',
  'target-below-44': 'A touch target is smaller than 44x44 CSS px (warning only).'
};

// PNG header: 8-byte signature, then IHDR width/height as big-endian 32-bit integers.
export function parsePngSize(buffer) {
  if (!buffer || buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// A profile counts as RENDERED only when a real PNG exists that covers at least viewport x device pixel ratio. A full-page shot of
// a page that overflows sideways is legitimately wider than the viewport (that is the defect on show), never narrower.
// Nothing is called visually accepted without this.
export function isRendered(profile, png) {
  return !!png && png.width >= profile.viewport.width * profile.deviceScaleFactor && png.height >= profile.viewport.height * profile.deviceScaleFactor;
}

export function summarise({ target, path, browser, name, results }) {
  const profiles = results.map((r) => {
    const fails = r.findings.filter((f) => f.severity === 'fail'), warns = r.findings.filter((f) => f.severity === 'warn');
    const rendered = isRendered(r.profile, r.png);
    return { profile: r.name, viewport: r.profile.viewport, deviceScaleFactor: r.profile.deviceScaleFactor, touch: r.profile.hasTouch, rendered,
      screenshot: r.png ? { file: r.screenshot, width: r.png.width, height: r.png.height } : null,
      ok: rendered && fails.length === 0, failures: fails.length, warnings: warns.length, pageProblems: r.pageProblems };
  });
  const failures = results.flatMap((r) => r.findings.filter((f) => f.severity === 'fail').map((f) => ({ profile: r.name, ...f })));
  // Same rule as capture.mjs: a query string or fragment can carry a token, so the reported path never keeps one.
  return { schema_version: 1, target, path: String(path).replace(/[?#].*$/s, ''), browser, name,
    ok: profiles.length > 0 && profiles.every((p) => p.ok && p.pageProblems === 0),
    scope: 'layout heuristics measured in a real browser; no pixel or visual-baseline comparison is performed',
    profiles, failures };
}

export function renderReport(summary) {
  const lines = [`# Responsive audit: ${summary.path} (${summary.browser})`, '',
    `Result: **${summary.ok ? 'PASS' : 'FAIL'}** across ${summary.profiles.length} profile(s).`,
    '', `> Scope: ${summary.scope}. A pass means no measured layout defect, not that a person has accepted how it looks.`, '',
    '| Profile | Viewport | Rendered | Failures | Warnings |', '|---|---|---|---|---|'];
  for (const p of summary.profiles) lines.push(`| ${p.profile} | ${p.viewport.width}x${p.viewport.height} @${p.deviceScaleFactor}x${p.touch ? ' touch' : ''} | ${p.rendered ? 'yes' : '**no**'} | ${p.failures} | ${p.warnings} |`);
  if (summary.failures.length) {
    lines.push('', '## Failures');
    for (const f of summary.failures) lines.push(`- ${f.profile}: \`${f.check}\` on \`${f.element}\`${f.text ? ` ("${f.text}")` : ''} — ${CHECKS[f.check] || ''}`);
  }
  return `${lines.join('\n')}\n`;
}
