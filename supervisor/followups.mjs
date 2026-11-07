// Issue #864: review follow-ups are batched into one open issue per area, and a PR that keeps drawing new, different blocking
// findings is stopped early. Pure functions only: no I/O, no model call.

const SEG = s => String(s).split('/').filter(Boolean);

// The area of a pull request: the top-level directory that holds most of its changed files (a root-level file counts as "root").
// Ties go to the alphabetically first area so the key is stable. No files known: "general".
export function areaOf(files) {
  const counts = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    const parts = SEG(f);
    if (!parts.length) continue;
    const area = parts.length > 1 ? parts[0] : 'root';
    counts.set(area, (counts.get(area) || 0) + 1);
  }
  if (!counts.size) return 'general';
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0].replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'general';
}

export const batchMarker = area => `<!-- devtest-followup-batch v1 area=${area} -->`;
export const jobMarker = (job, pr, head) => `<!-- devtest-review-followup v1 job=${job} pr=${pr} head=${head} -->`;
const norm = t => String(t).toLowerCase().replace(/\s+/g, ' ').trim();

// Adds one review's follow-ups to a batch issue body. Idempotent per review job (its marker is in the body already: nothing changes),
// and a finding whose text is already listed is not added twice. Returns { body, added }.
export function appendToBatch(body, { job, pr, head, items }) {
  const marker = jobMarker(job, pr, head);
  if (String(body).includes(marker)) return { body: String(body), added: 0 };
  const have = new Set(String(body).split('\n').map(l => norm(l.replace(/^\s*-\s*/, ''))));
  const fresh = [], seen = new Set();
  for (const t of items) { const n = norm(t); if (n && !have.has(n) && !seen.has(n)) { seen.add(n); fresh.push(t); } }
  const section = `${marker}\nFrom PR #${pr} at head \`${head}\`:\n${fresh.length ? fresh.map(t => `- ${t}`).join('\n') : '- _nothing new: every finding was already listed above_'}`;
  return { body: `${String(body).replace(/\s+$/, '')}\n\n${section}\n`, added: fresh.length };
}

export function newBatchBody(area, { job, pr, head, items }) {
  const head0 = `${batchMarker(area)}\nBatched non-blocking review findings for the \`${area}\` area. Foreman adds the follow-ups of later reviews here instead of opening one issue per review; one implementer run clears the list. Follow-up from PR #${pr}.`;
  return appendToBatch(head0, { job, pr, head, items }).body;
}

// A batch is only started when something material is in it: a finding the reviewer wrote. A list made only of immaterial
// description-claim notes is appended to an existing batch but never opens an issue by itself.
export const isMaterial = findings => findings.some(f => f && f.kind === 'follow-up' && String(f.text || '').trim());

// Churn (issue #864): the blocking findings of consecutive CHANGES verdicts. A finding repeats an earlier one when it shares any five
// consecutive words with it (or, for a short one, the whole text). Two rounds in a row whose blocking findings are all new
// (nothing repeats the round before) is churn: the fixes are not converging and more rounds only draw new findings.
function words(t) { return String(t).toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim().split(' ').filter(Boolean); }
export function repeats(a, b) {
  const x = words(a), y = ` ${words(b).join(' ')} `;
  if (x.length < 5) return y.includes(` ${x.join(' ')} `);
  for (let i = 0; i + 5 <= x.length; i++) if (y.includes(` ${x.slice(i, i + 5).join(' ')} `)) return true;
  return false;
}
const blocking = v => (v.findings || []).filter(f => f.kind === 'blocking').map(f => f.text);
const disjoint = (later, earlier) => later.length > 0 && later.every(t => !earlier.some(e => repeats(t, e) || repeats(e, t)));

// history: reviewHistory(pr) (oldest first). Returns null, or the three rounds side by side.
export function churnRounds(history, { rounds = 2 } = {}) {
  const need = rounds + 1;
  const tail = history.slice(-need);
  if (tail.length < need || !tail.every(v => v.verdict === 'CHANGES')) return null;
  const sets = tail.map(blocking);
  for (let i = 1; i < sets.length; i++) if (!disjoint(sets[i], sets[i - 1])) return null;
  return tail.map((v, i) => ({ head: v.head, reviewer: v.reviewer, blocking: sets[i] }));
}

export function churnText(rounds) {
  const clip = t => String(t).replace(/\s+/g, ' ').slice(0, 300);
  return rounds.map((r, i) => `Round ${i + 1} (head \`${String(r.head).slice(0, 12)}\`):\n${r.blocking.slice(0, 8).map(t => `  - ${clip(t)}`).join('\n')}`).join('\n');
}

// Issue #963: no follow-up of a follow-up. Non-blocking findings only ever go to the open area batch issue (batchFollowUps); Foreman
// opens no standalone follow-up issue for them. These helpers recognise follow-up issues and plan the one-off fold of the old backlog.
const FOLLOW_TITLE = /^\s*(Review follow-ups?\b|Follow-up from PR #\d+)/i;
const PARENT_PR = /(?:Review follow-ups? for PR|Follow-up (?:from|to|of) PR|Split out of PR|From PR)\s*#(\d+)/i;
export const isBatchIssue = i => String(i?.body || '').includes('devtest-followup-batch');
export const isFollowUpIssue = i => isBatchIssue(i) || /devtest-review-followup|devtest-split/.test(String(i?.body || '')) || FOLLOW_TITLE.test(String(i?.title || ''));

// The merged-or-not parent PR of a follow-up issue: the first PR number in its body, else in its title. null when none can be read.
export function parentPrOf(issue) {
  const m = PARENT_PR.exec(String(issue?.body || '')) || PARENT_PR.exec(String(issue?.title || ''));
  return m ? Number(m[1]) : null;
}

// A plain title names what the follow-up changes and never chains the parent PR ("Review follow-ups for PR #850 Review follow-ups ...").
export function plainTitle(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 12; i++) {
    const n = t.replace(/^(?:Review follow-ups?|Follow-up from PR #\d+|Follow-ups?)\s*(?:for|of|to|from)?\s*(?:PR\s*)?#?\d*\s*(?:\(issue #\d+\))?\s*[:\-–]?\s*/i, '');
    if (n === t) break;
    t = n;
  }
  return t || 'Review follow-ups';
}

// issues: open issues {number,title,body}. parents: Map prNumber -> { state: 'MERGED'|..., files: [paths] } for each parent PR.
// Returns { fold: [{ issue, parent, area }], keep: [...], unclassified: [{ issue, why }] }. Batch issues are never folded; a follow-up
// whose parent is not merged (or unreadable) stays open and is listed for the homeowner when the parent cannot be read at all.
export function planFold(issues, parents) {
  const fold = [], keep = [], unclassified = [];
  for (const i of issues) {
    if (!isFollowUpIssue(i) || isBatchIssue(i)) continue;
    const parent = parentPrOf(i);
    if (parent == null) { unclassified.push({ issue: i.number, why: 'no parent pull request found in the title or body' }); continue; }
    const p = parents.get(parent);
    if (!p) { unclassified.push({ issue: i.number, why: `parent PR #${parent} could not be read` }); continue; }
    if (p.state !== 'MERGED') { keep.push({ issue: i.number, parent, why: `parent PR #${parent} is ${String(p.state).toLowerCase()}` }); continue; }
    fold.push({ issue: i.number, parent, area: areaOf(p.files) });
  }
  return { fold, keep, unclassified };
}

// What a folded issue adds to its batch: its plain title plus its non-marker body lines, clipped.
export function foldItems(issue) {
  const lines = String(issue.body || '').split('\n').map(l => l.trim()).filter(l => /^[-*]\s+\S/.test(l)).map(l => l.replace(/^[-*]\s+/, ''));
  const clip = t => (t.length > 400 ? `${t.slice(0, 399)}…` : t);
  return (lines.length ? lines : [plainTitle(issue.title)]).slice(0, 20).map(t => clip(`${t} (was #${issue.number})`));
}
