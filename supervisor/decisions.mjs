// Issue #303: decision-register governance. Only the homeowner may make an entry homeowner-approved. Pure functions.
// An agent adds entries as `agent-proposal`; a change to or from `homeowner-approved` needs a recorded, verifiable homeowner approval.

const ENTRY = /^## (D-\d{3}) [—-] ([^\n]*)\n((?:(?!^## ).*\n?)*)/gm;
export const APPROVED = 'homeowner-approved';

// id -> { title, status, source } for every entry in a register text. A duplicate id keeps the first (and is reported by `duplicates`).
export function parseRegister(text) {
  const out = new Map(), dup = [];
  for (const m of String(text || '').matchAll(ENTRY)) {
    if (out.has(m[1])) { dup.push(m[1]); continue; }
    out.set(m[1], { title: m[2].trim(), status: /^- Status: (\S+)\s*$/m.exec(m[3])?.[1] ?? null, source: /^- Source: (.*)$/m.exec(m[3])?.[1] ?? '' });
  }
  out.duplicates = dup;
  return out;
}

// The approval a PR comment records: a line `homeowner-approval: D-025 [D-026 ...]` written by the repository owner.
export function approvalsFrom(comments, owner) {
  const out = new Map();   // id -> [{ url, id }]
  for (const c of comments || []) {
    if (!c || String(c.login || '').toLowerCase() !== String(owner || '').toLowerCase() || !owner) continue;
    for (const line of String(c.body || '').split('\n')) {
      const m = /^homeowner-approval:\s*((?:D-\d{3}[\s,]*)+)$/.exec(line.trim());
      if (!m) continue;
      for (const id of m[1].match(/D-\d{3}/g)) (out.get(id) || out.set(id, []).get(id)).push({ url: String(c.url || ''), id: String(c.id ?? '') });
    }
  }
  return out;
}

// Violations between the base and head registers. approvals = approvalsFrom(...) (empty map when none).
export function decisionViolations(baseText, headText, approvals = new Map()) {
  const base = parseRegister(baseText), head = parseRegister(headText), bad = [];
  const approvedBy = (id, needLink) => {
    const list = approvals.get(id) || [];
    if (!list.length) return false;
    if (!needLink) return true;
    const src = head.get(id)?.source || '';
    return list.some(a => (a.url && src.includes(a.url)) || (a.id && new RegExp(`issuecomment-${a.id}\\b`).test(src)));
  };
  for (const [id, h] of head) {
    const b = base.get(id);
    if (!b) {
      if (h.status === APPROVED && !approvedBy(id, true)) bad.push(`${id} is added as ${APPROVED}; agents add entries as agent-proposal only (or the Source must link a recorded homeowner approval comment: "homeowner-approval: ${id}")`);
      continue;
    }
    if (b.status === h.status) continue;
    if (h.status === APPROVED && !approvedBy(id, true)) bad.push(`${id} changes status ${b.status} -> ${APPROVED} without a verifiable homeowner approval (comment "homeowner-approval: ${id}" by the repository owner, linked from the entry's Source)`);
    else if (b.status === APPROVED && !approvedBy(id, false)) bad.push(`${id} changes status ${APPROVED} -> ${h.status} without a verifiable homeowner instruction (comment "homeowner-approval: ${id}" by the repository owner)`);
  }
  for (const [id, b] of base) if (!head.has(id)) bad.push(`${id} was removed; entries are never deleted (supersede them instead)`);
  for (const id of head.duplicates) bad.push(`${id} appears twice in the register`);
  return bad;
}

// Entries a PR head adds as proposals (absent from main): what awaits the homeowner's sign-off.
export function proposalsAdded(mainText, headText) {
  const main = parseRegister(mainText);
  return [...parseRegister(headText)].filter(([id, h]) => !main.has(id) && h.status === 'agent-proposal').map(([id, h]) => ({ id, title: h.title }));
}

// Issue #303: which decisions code must check, and what the check is. Every other entry is policy enforced elsewhere (a validator,
// CI, the launcher) or by review, and is listed so a new entry has to be classified. `gate` names the test-covered behaviour.
export const ENFORCED_DECISIONS = Object.freeze({
  'D-020': 'full access launch mode: the dispatcher refuses to launch anything while the cited access decision is not approved',
  'D-021': 'interim same-provider review: an interim PASS merges only while D-021 (or D-024) is approved',
  'D-024': 'review independence by model: an independent same-provider PASS merges only once D-024 is approved',
  'D-025': 'verdict carry across a clean rebase: no PASS carries until D-025 is approved'
});
