// Issue #855: a change is done when it is installed and working, so "the homeowner can do X after deploy" is never an accepted resolution.
// Pure text rules for the pull request description. A step that truly cannot be automated is listed under a "Homeowner steps" heading
// (and shows in Needs you); anything else that defers work to the homeowner after deploy draws CHANGES.
export const HEADING = /^#{1,6}\s*homeowner steps\b.*$/im;
const DEFERRAL = [
  /\b(?:for|to be done by|left (?:to|for)|up to) the homeowner\b(?:[^.\n]|\.(?=\S)){0,60}\b(?:after|once|when)\b(?:[^.\n]|\.(?=\S)){0,30}\b(?:deploy|deployed|deployment|install|installed|merge|merged|release|released)/i,
  /\bhomeowner\b(?:[^.\n]|\.(?=\S)){0,40}\b(?:can|should|must|needs? to|will need to|has to|may want to|will have to)\b(?:[^.\n]|\.(?=\S)){0,100}\b(?:after|once|when)\b(?:[^.\n]|\.(?=\S)){0,30}\b(?:deploy|deployed|deployment|install|installed|merge|merged|release|released)/i,
  /\b(?:after|once|when)\b(?:[^.\n]|\.(?=\S)){0,20}\b(?:deploy|deployed|deployment|install|installed|merge|merged|release|released)\b(?:[^.\n]|\.(?=\S)){0,60}\b(?:the )?homeowner\b(?:[^.\n]|\.(?=\S)){0,40}\b(?:can|should|must|needs? to|has to|sets?|adds?|edits?|runs?|clicks?|configures?|restarts?)\b/i,
  /\bhomeowner\b(?:[^.\n]|\.(?=\S)){0,40}\b(?:can|should|must|needs? to|will need to|has to|will|to)\b(?:[^.\n]|\.(?=\S)){0,100}\bpost-?(?:deploy|deployment|install|merge)/i,
  /\bmanual (?:step|setting|action)s?\b(?:[^.\n]|\.(?=\S)){0,60}\bafter (?:deploy|deployment|install|merge)/i,
];
// Splits the body into the "Homeowner steps" section (to the next heading) and the rest.
export function splitSteps(body) {
  const text = String(body ?? '').replace(/\r/g, ''), m = HEADING.exec(text);
  if (!m) return { steps: [], rest: text };
  const after = text.slice(m.index + m[0].length), next = /^#{1,6}\s/m.exec(after);
  const section = next ? after.slice(0, next.index) : after;
  const steps = section.split('\n').map(l => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim()).filter(l => l && !/^_?none\.?_?$/i.test(l));
  return { steps, rest: text.slice(0, m.index) + (next ? after.slice(next.index) : '') };
}
// Lines outside the Homeowner steps section that defer a step to the homeowner after deploy.
// A sentence that says the opposite ("Nothing is left for the homeowner after deploy", "No step for the homeowner") or only quotes the phrase
// is not a deferral: quoted text is dropped, and a negated sentence is skipped. Matching is per sentence so one negation does not hide another.
const NEGATED = /\b(?:no|nothing|none|never|without|not|isn'?t|aren'?t|doesn'?t|don'?t|won'?t|zero)\b/i;
const stripQuoted = l => l.replace(/`[^`]*`|"[^"]*"|\u201c[^\u201d]*\u201d/g, ' ');
const sentences = l => stripQuoted(l).split(/(?<=[.!?;])\s+/);
// A negation only cancels the deferral when it comes before the homeowner is named ("Nothing is left for the homeowner", "No step for the homeowner");
// one after it ("the homeowner must set X after deploy, or writes will not work") does not hide the step.
const negatedBefore = x => { const h = /\bhomeowner\b/i.exec(x); return NEGATED.test(h ? x.slice(0, h.index) : x); };
const defers = l => sentences(l).some(x => DEFERRAL.some(re => re.test(x)) && !negatedBefore(x));
export const deferredSteps = body => splitSteps(body).rest.split('\n').map(l => l.trim()).filter(l => l && defers(l)).map(l => l.slice(0, 300));
export const homeownerSteps = body => splitSteps(body).steps.map(s => s.slice(0, 300));

const MARK = 'Deferred homeowner step (issue #855):';
// Only ever tightens: PASS (or any verdict that did not name it) becomes CHANGES with a blocking finding per deferred step.
export function enforceNoDeferredSteps(v, body) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.findings)) return v;
  const lines = deferredSteps(body).filter(l => !v.findings.some(f => f?.kind === 'blocking' && String(f.text).includes(l.slice(0, 80))));
  if (!lines.length) return v;
  const findings = [...v.findings];
  for (const l of lines.slice(0, 5)) if (findings.length < 50) findings.push({ kind: 'blocking', text: `${MARK} the pull request description leaves a step for the homeowner after deploy: "${l}". Foreman owns every step: ship a migration for a local setting, raise a host-value inbox item for a host-specific value, or add a live check. A step that truly needs the homeowner's credentials or a physical action goes under a "Homeowner steps" heading.`.slice(0, 2000) });
  return { ...v, verdict: 'CHANGES', findings };
}
