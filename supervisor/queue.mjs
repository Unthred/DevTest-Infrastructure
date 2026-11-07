// Issue #863: one queue of every open issue and pull request, in the order Foreman will take them, with the reason for each position, what it
// waits on and an estimated start time. Not a scoring engine and not a second planner: the order is the planner's own. Team.plan({ queue: true })
// runs the real dispatch with no slot limit and records each pick (team.queued); this module only labels, times and groups those picks.
// Pure apart from reads on the Team object it is given. The dashboard page, the overview strip and foreman_queue all use it, so they cannot disagree.
import { ROLES, agentGenerated, agentOfBranch, issueOfBranch, overallCap, roleCount, roleOfType } from './team.mjs';
import { MIN_SAMPLES, stepStats } from './estimate.mjs';
import { redact } from './redact.mjs';

export const TYPES = ['implement', 'review', 'fix', 'cifix', 'rebase', 'continue', 'merge'];
export const TYPE_LABEL = { implement: 'Implement', review: 'Review', fix: 'Fix', cifix: 'CI fix', rebase: 'Rebase', continue: 'Continue', merge: 'Merge', inbox: 'Overseer prompt', wait: 'Waiting' };
export const ROLE_LABEL = { implementer: 'Implementer', reviewer: 'Reviewer', rebaser: 'Rebaser' };
export const STRIP_DONE = 4, STRIP_NEXT = 6, MAX_ITEMS = 600;
export const ESTIMATE_NOTE = 'Estimate: counted from the jobs ahead, the free slots for the role and the median duration of that job type over recent jobs. It is not a promise.';
const ACTIVE = ['queued', 'running', 'paused_limit', 'paused_manual'];
const FINISHED = ['completed', 'failed', 'blocked', 'cancelled', 'abandoned'];
const fin = Number.isFinite;
const clip = (t, n = 300) => redact(String(t ?? ''), n);
const durText = ms => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

// Wait kinds, as the page words them. `needsMe` kinds are the ones only the homeowner can clear.
const HOMEOWNER_WORDS = /needs the homeowner|waiting for the homeowner|needs-homeowner|fix limit reached|homeowner decision|homeowner must/i;
function classifyWait(text) {
  const t = String(text || '');
  if (HOMEOWNER_WORDS.test(t)) return 'homeowner';
  if (/allowance|usage limit|reviews-only|weekly|reset/i.test(t)) return 'allowance';
  if (/open-PR cap|Paused new work|open PRs \(cap/i.test(t)) return 'cap';
  if (/slot full|overall cap/i.test(t)) return 'slot';
  if (/expected to edit/i.test(t)) return 'overlap';
  if (/blocked by|waiting for PR|prerequisite/i.test(t)) return 'prerequisite';
  if (/CI|check/i.test(t)) return 'ci';
  return 'other';
}

// Median (50th percentile, nearest rank) duration per job type from recent jobs, with the sample count. Types with fewer than MIN_SAMPLES give null.
export function medians(jobs, state) {
  const stats = stepStats(jobs, state), out = {};
  for (const [t, s] of Object.entries(stats)) out[t] = s.n >= MIN_SAMPLES && fin(s.p50) ? { ms: s.p50, n: s.n } : null;
  out.inbox = out.implement ?? null; out.merge = { ms: 0, n: 0 };
  return out;
}

// What a job record is about: its kind and the issue or pull request it works on.
function jobFacts(j, state) {
  const r = state?.jobs?.[j.id] || {}, kind = r.kind || j.kind || 'job';
  const writer = ['implement', 'continue'].includes(kind);
  const ref = writer ? (r.issue ?? j.issue ?? issueOfBranch(r.branch || j.branch)) : (r.pr ?? j.issue ?? null);
  return { kind, ref: Number.isSafeInteger(ref) ? ref : null, refKind: writer ? 'issue' : 'pull', role: roleOfType(kind), agent: r.agent || null };
}

// Estimated start of each queued pick: a slot model per role, seeded with the jobs running now (each holds its slot for the rest of the typical
// duration of its type), filled in the planner's own order. A type with no usable median makes every later start in that slot unknown.
function schedule({ queued, running, medianOf, L, now, startFloor }) {
  const free = Object.fromEntries(ROLES.map(r => [r, Array.from({ length: Math.max(1, roleCount(L, r)) }, () => now)]));
  const ends = new Map();
  for (const r of running) {
    const slots = free[r.role]; if (!slots) continue;
    const m = medianOf(r.kind), end = m ? Math.max(now, (r.startedAt ?? now) + m.ms) : null;
    let k = 0; for (let i = 1; i < slots.length; i++) if ((slots[i] ?? Infinity) < (slots[k] ?? Infinity)) k = i;
    slots[k] = end; ends.set(r, end);
  }
  const out = new Map();
  for (const q of queued) {
    if (q.type === 'merge') { out.set(q, { start: startFloor, end: startFloor, basis: 'merges on the next tick' }); continue; }
    const slots = free[q.role], m = medianOf(q.type);
    let k = 0; for (let i = 1; i < slots.length; i++) if ((slots[i] ?? Infinity) < (slots[k] ?? Infinity)) k = i;
    const at = slots[k], start = at === null ? null : Math.max(at, startFloor), end = start !== null && m ? start + m.ms : null;
    slots[k] = end;
    out.set(q, { start, end, basis: m ? `median ${durText(m.ms)} of ${m.n} recent ${TYPE_LABEL[q.type]?.toLowerCase() || q.type} jobs` : `no estimate yet: fewer than ${MIN_SAMPLES} recent ${q.type} jobs` });
  }
  return { times: out, ends };
}

// The reason an item sits where it does: the priority rule that put it there, in the planner's own terms.
function positionReason(team, act, prs) {
  const lane = ROLE_LABEL[act.role] || act.role;
  switch (act.type) {
    case 'merge': return 'merge comes first: a PASS on the current head with green CI; Foreman merges one pull request per tick';
    case 'review': {
      const pos = team.reviewQueue(act.agent, prs).find(r => r.pr.number === act.pr);
      const rule = pos ? `review order ${pos.position} of ${pos.of}: ${pos.reason}` : 'review order: closest to merge first, then oldest';
      return `${rule}${act.why ? `; ${act.why}` : ''}`;
    }
    case 'rebase': return `rebase comes before any other work on this pull request: it conflicts with its base${act.behind ? ' (or is behind its base with a PASS)' : ''}; one rebase at a time, in merge order`;
    case 'cifix': return `repair work outranks new work: CI is failing on the current head${act.escalated ? ' (escalated past the fix limit)' : ''}`;
    case 'fix': return `repair work outranks new work: the review gave CHANGES on the current head${act.escalated ? ' (escalated past the fix limit)' : ''}`;
    case 'continue': return 'repair work outranks new work: an unfinished draft pull request for an open issue';
    case 'inbox': return 'an overseer prompt you approved goes first, ahead of issues';
    case 'implement': {
      if (act.reassignedFrom) return clip(act.reassignReason || `taken over from ${act.reassignedFrom}`);
      const order = team.candidates(act.agent), idx = order.indexOf(act.issue);
      const issue = (team.view?.issues || []).find(i => i.number === act.issue);
      const who = agentGenerated(issue) ? 'an agent-generated follow-up: taken after the homeowner\'s issues' : 'raised by the homeowner: taken before agent-generated follow-ups';
      const listed = (team.c.agents[act.agent]?.issues || []).includes(act.issue);
      return `${who}; ${listed ? `then ${act.agent}'s issue list order` : 'then lowest issue number first'}${idx >= 0 ? ` (candidate ${idx + 1} of ${order.length} for ${act.agent})` : ''}`;
    }
    default: return `${lane} lane order`;
  }
}

// Build the queue from a Team that has just run plan({ queue: true }).
// team: that Team. queues: dashboard.mjs reasons() output (plain-words status per agent, the fallback for waits). jobs: supervisor job records.
// needsYou: the consolidated Needs-you items ({ ref: { kind, n }, text, action }). breaker: the halt view or null.
export function buildQueue({ team, queues = {}, jobs = [], state = {}, names, needsYou = [], breaker = null, nextTickAt = null, now = Date.now() }) {
  const c = team.c, L = c.limits, prs = team.view?.prs || [], issues = team.view?.issues || [];
  const issueByNo = new Map(issues.map(i => [i.number, i])), prByNo = new Map(prs.map(p => [p.number, p]));
  const nameOf = (kind, n) => clip(kind === 'issue' ? names.issue(n).text : names.pr(n).text, 200);
  const urlOf = (kind, n) => (kind === 'issue' ? `/work/issue/${n}` : `/work/pr/${n}`);
  const med = medians(jobs, state), medianOf = t => med[t] ?? null;
  const startFloor = fin(nextTickAt) && nextTickAt > now ? nextTickAt : now;
  const needs = new Map(needsYou.filter(n => n.ref && fin(n.ref.n)).map(n => [`${n.ref.kind === 'pull' ? 'pr' : 'issue'}:${n.ref.n}`, n]));
  const items = [], covered = new Set();   // covered: "issue:n" / "pr:n" already shown by a running or queued item
  const cover = (kind, n) => covered.add(`${kind}:${n}`);
  const homeownerNote = key => { const n = needs.get(key); return n ? { text: clip(n.text), action: clip(n.action || '') } : null; };

  // Running (and paused) jobs.
  const active = jobs.filter(j => ACTIVE.includes(j.status));
  const running = active.map(j => {
    const f = jobFacts(j, state), paused = j.status.startsWith('paused');
    return { job: j, ...f, startedAt: j.createdAt, paused, holdsSlot: j.status !== 'paused_limit' };
  });
  const queued = team.queued || [];
  const { times, ends } = schedule({ queued, running: running.filter(r => r.holdsSlot && !r.paused), medianOf, L, now, startFloor });

  for (const r of running) {
    const kindKey = r.refKind === 'issue' ? 'issue' : 'pr';
    if (r.ref !== null) cover(kindKey, r.ref);
    const typeLabel = TYPE_LABEL[r.kind] || r.kind;
    const state_ = r.paused ? 'retry' : 'running';
    items.push({ key: `job:${r.job.id}`, number: r.ref, kind: r.ref === null ? 'job' : kindKey, name: r.ref === null ? clip(names.job(r.job).text, 200) : nameOf(kindKey, r.ref), url: r.ref === null ? `/work/job/${String(r.job.id).slice(0, 8)}` : urlOf(kindKey, r.ref),
      type: r.kind, typeLabel, role: r.role, agent: r.agent, state: state_, jobId: r.job.id,
      estStart: r.startedAt ?? null, estEnd: ends.get(r) ?? null, estimate: false,
      reason: r.paused ? `${typeLabel} paused (${r.job.status === 'paused_limit' ? 'usage limit' : 'paused by hand'}); it resumes inside the limits` : `${typeLabel} is running now`,
      waitsOn: r.paused ? { kind: r.job.status === 'paused_limit' ? 'allowance' : 'other', text: r.job.status === 'paused_limit' ? 'a usage limit to reset' : 'a person to resume it', action: r.job.status === 'paused_limit' ? null : 'resume it from the dashboard' } : null,
      needsMe: false, since: r.startedAt });
  }

  // Queued picks, in the planner's order.
  const sameBreaker = breaker ? { kind: 'breaker', text: clip(breaker.text || 'the circuit breaker has halted new jobs'), action: clip(breaker.action || 'review it on the dashboard and resume') } : null;
  queued.forEach((q, order) => {
    const kind = ['implement', 'continue', 'inbox'].includes(q.type) && q.issue != null ? 'issue' : q.type === 'inbox' ? 'inbox' : 'pr';
    const n = kind === 'issue' ? q.issue : q.pr;
    if (kind !== 'inbox') cover(kind, n);
    if (q.type === 'continue' && q.pr != null) cover('pr', q.pr);
    const t = times.get(q), fitsNow = q.fits;
    const nm = kind === 'inbox' ? clip(`Overseer proposal: ${q.title || q.inboxId}`, 200) : nameOf(kind, n);
    const homeowner = kind === 'inbox' ? null : homeownerNote(`${kind}:${n}`);
    const busy = (running.filter(r => r.holdsSlot && !r.paused && r.role === q.role).map(r => r.ref !== null ? nameOf(r.refKind === 'issue' ? 'issue' : 'pr', r.ref) : 'a job')).slice(0, 3);
    let waitsOn = null;
    if (sameBreaker) waitsOn = sameBreaker;
    else if (homeowner) waitsOn = { kind: 'homeowner', text: homeowner.text, action: homeowner.action || null };
    else if (!fitsNow && q.type !== 'merge') waitsOn = { kind: 'slot', text: `a free ${ROLE_LABEL[q.role].toLowerCase()} slot (${roleCount(L, q.role)} slot${roleCount(L, q.role) === 1 ? '' : 's'}${overallCap(L) ? `, overall cap ${overallCap(L)}` : ''}${busy.length ? `; busy with ${busy.join('; ')}` : ''})`, action: null };
    items.push({ key: `q:${order}`, number: kind === 'inbox' ? null : n, kind, name: nm, url: kind === 'inbox' ? '/' : urlOf(kind, n), type: q.type, typeLabel: TYPE_LABEL[q.type] || q.type, role: q.role, agent: q.agent || null,
      state: waitsOn?.kind === 'homeowner' ? 'needs-you' : waitsOn ? 'waiting' : 'queued', order, startsNow: fitsNow && !waitsOn,
      estStart: sameBreaker || homeowner ? null : (t?.start ?? null), estEnd: t?.end ?? null, estimate: true, estimateBasis: t?.basis || null,
      reason: clip(positionReason(team, { ...q, role: q.role }, prs), 400), waitsOn, needsMe: !!homeowner });
  });

  // Everything else that is open: waiting, with what it waits on.
  const reasonOf = (kind, n) => { for (const q of Object.values(queues)) for (const e of q) if (e.ref === n && e.type === (kind === 'issue' ? 'issue' : 'pr')) return e.reason; return null; };
  const heldText = type => Object.values(team.held || {}).map(h => h?.[type]).filter(Boolean)[0] || null;
  const queuedByRef = new Map(items.filter(i => i.state !== 'running' && i.number != null).map(i => [`${i.kind}:${i.number}`, i]));
  const pause = team.pauseInfo(prs, issues) ? team.pauseText(prs, issues) : null;
  const waitItems = [];
  for (const pr of prs) {
    if (covered.has(`pr:${pr.number}`)) continue;
    const author = agentOfBranch(c, pr.headRefName);
    if (!author) continue;
    const text = reasonOf('pr', pr.number) || (pr.isDraft ? 'draft' : 'waiting');
    const ho = homeownerNote(`pr:${pr.number}`), hold = team.heldPr?.[`${author}:review:${pr.number}`] || null;
    let kind = ho || pr.labels?.includes('needs-homeowner') ? 'homeowner' : classifyWait(hold || text);
    if (pr.labels?.includes('needs-homeowner') && !ho) kind = 'homeowner';
    const merged = team.queued?.find(q => q.type === 'merge');
    let waitText = clip(ho?.text || hold || text);
    let action = ho?.action || null;
    if (/^PASS from/.test(text) && merged && merged.pr !== pr.number) { waitText = `one merge per tick: ${nameOf('pr', merged.pr)} merges first. ${text}`; kind = 'other'; }
    if (kind === 'homeowner' && !action) action = 'Open it on the dashboard and decide.';
    waitItems.push({ key: `w:pr:${pr.number}`, number: pr.number, kind: 'pr', name: nameOf('pr', pr.number), url: urlOf('pr', pr.number), type: 'wait', typeLabel: pr.isDraft ? 'Draft pull request' : 'Pull request', role: author ? roleOfType('review') : null, agent: author,
      state: kind === 'homeowner' ? 'needs-you' : 'waiting', estStart: null, estimate: true, estimateBasis: 'no estimate: it is not eligible to run yet', reason: 'not in the planner\'s list yet; it waits for the condition below', waitsOn: { kind, text: waitText, action }, needsMe: kind === 'homeowner' });
  }
  for (const issue of issues) {
    if (issue.state !== 'OPEN' || covered.has(`issue:${issue.number}`) || team.delivered?.has(issue.number)) continue;
    const n = issue.number;
    const carrier = prs.find(p => agentOfBranch(c, p.headRefName) && new RegExp(`/issue-${n}(\\D|$)`).test(p.headRefName));
    if (carrier) {   // its pull request carries it: listed (every open issue is), grouped with that pull request, and never a second place in the order
      waitItems.push({ key: `w:issue:${n}`, number: n, kind: 'issue', name: nameOf('issue', n), url: urlOf('issue', n), type: 'implement', typeLabel: TYPE_LABEL.implement, role: 'implementer', agent: agentOfBranch(c, carrier.headRefName),
        state: 'waiting', estStart: null, estimate: false, estimateBasis: null, carriedBy: carrier.number, reason: `its work is in ${nameOf('pr', carrier.number)}; the issue closes when that pull request merges`,
        waitsOn: { kind: 'pr', text: `${nameOf('pr', carrier.number)} to merge`, action: null }, needsMe: false });
      continue;
    }
    const ex = team.exclusion(n, issueByNo, prs), ho = homeownerNote(`issue:${n}`);
    let wait;
    const owner = c.agents && Object.keys(c.agents).find(a => team.candidates(a).includes(n)) || Object.keys(c.agents)[0];
    if (ex?.kind === 'label' && ex.label === 'needs-homeowner') wait = { kind: 'homeowner', text: 'it carries the needs-homeowner label', action: 'Remove the needs-homeowner label when you want work to begin.' };
    else if (ex?.kind === 'label') wait = { kind: 'other', text: `it is labelled ${ex.label}, so Foreman does not start it`, action: null };
    else if (ex?.kind === 'prerequisite') wait = { kind: 'prerequisite', text: `blocked by ${ex.refs.map(d => nameOf('issue', d)).join(', ')}`, action: null, blockers: ex.refs };
    else if (ex) wait = { kind: ex.kind === 'pr-wait' ? 'prerequisite' : 'other', text: clip(ex.text), action: ex.kind === 'pr-closed' ? 'Decide whether the issue should still go ahead.' : null, blockers: ex.refs };
    else if (team.overlapOf?.get(`implement:${n}`)) { const o = team.overlapOf.get(`implement:${n}`); wait = { kind: 'overlap', text: `expected to edit ${o.file}, which ${nameOf('issue', o.other)} also edits`, action: null, blockers: [o.other] }; }
    else if (pause) wait = { kind: 'cap', text: `${clip(pause)}; no new implement job starts until a pull request merges or is closed`, action: 'Merge or close an open pull request.' };
    else if (heldText('implement')) { const h = heldText('implement'); wait = { kind: classifyWait(h), text: clip(h), action: null }; }
    else wait = { kind: classifyWait(reasonOf('issue', n)), text: clip(reasonOf('issue', n) || 'not eligible yet'), action: null };
    if (ho) wait = { kind: 'homeowner', text: ho.text, action: ho.action || wait.action };
    if (breaker && wait.kind !== 'homeowner') wait = { kind: 'breaker', text: clip(breaker.text || 'the circuit breaker has halted new jobs'), action: clip(breaker.action || '') };
    waitItems.push({ key: `w:issue:${n}`, number: n, kind: 'issue', name: nameOf('issue', n), url: urlOf('issue', n), type: 'implement', typeLabel: TYPE_LABEL.implement, role: 'implementer', agent: owner,
      state: wait.kind === 'homeowner' ? 'needs-you' : 'waiting', estStart: null, estimate: true, estimateBasis: null,
      reason: `${agentGenerated(issue) ? 'an agent-generated follow-up' : 'raised by the homeowner'}; not in the planner's list until the condition below clears`, waitsOn: wait, needsMe: wait.kind === 'homeowner', blockers: wait.blockers });
  }
  // A start time for what waits on another item: just after that item is expected to finish.
  const endOf = (kind, n) => { const i = [...items, ...waitItems].find(x => x.kind === kind && x.number === n); return i && fin(i.estEnd) ? i.estEnd : null; };
  for (const w of waitItems) {
    if (!w.blockers?.length || w.waitsOn.kind === 'homeowner') continue;
    const ends = w.blockers.map(b => endOf('issue', b));
    if (ends.every(fin)) { w.estStart = Math.max(...ends, startFloor); w.estimateBasis = `after ${w.blockers.map(b => nameOf('issue', b)).join(', ')} is expected to finish`; w.afterBlocker = true; }
  }
  items.push(...waitItems);

  // Groups: an issue and the pull request(s) that carry it flow as one piece of work, so they are shown together.
  const groupOf = it => {
    if (it.kind === 'issue') return it.number;
    if (it.kind === 'pr') { const p = prByNo.get(it.number); const n = p ? (p.closingIssuesReferences?.[0]?.number ?? issueOfBranch(p.headRefName)) : null; return Number.isSafeInteger(n) ? n : null; }
    return null;
  };
  const members = new Map();
  for (const it of items) { const g = groupOf(it); if (g != null) { it.group = `issue-${g}`; (members.get(it.group) || members.set(it.group, []).get(it.group)).push(it); } }
  for (const [g, list] of members) if (list.length < 2) { for (const it of list) delete it.group; members.delete(g); }
  const groups = [...members].map(([key, list]) => ({ key, label: nameOf('issue', Number(key.slice(6))), members: list.map(i => i.key) }));

  // One global order: running first, then by estimated start (unknown last), then the planner's own pick order, then waiting items by number.
  const rank = i => (i.state === 'running' ? 0 : i.state === 'retry' ? 1 : i.order !== undefined ? 2 : 3);
  items.sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? ((a.estStart ?? Infinity) - (b.estStart ?? Infinity) || a.order - b.order) : 0) || ((a.number ?? 0) - (b.number ?? 0)));
  // Members of a group are shown together, right after the member that ranks first.
  { const seen = new Set(), out = [];
    for (const it of items) { if (it.group) { if (seen.has(it.group)) continue; seen.add(it.group); out.push(...items.filter(x => x.group === it.group)); } else out.push(it); }
    items.splice(0, items.length, ...out); }
  const total = items.length;
  items.forEach((it, i) => { it.position = i + 1; });

  // The strip: per role, centred on now.
  const finished = jobs.filter(j => FINISHED.includes(j.status) && fin(j.updatedAt)).sort((a, b) => b.updatedAt - a.updatedAt);
  const lanes = ROLES.map(role => {
    const mine = items.filter(i => i.role === role);
    const flow = mine.filter(i => ['queued', 'waiting'].includes(i.state) && i.order !== undefined);
    const done = finished.map(j => ({ j, f: jobFacts(j, state) })).filter(x => x.f.role === role && x.f.ref !== null).slice(0, STRIP_DONE).reverse().map(({ j, f }) => {
      const kind = f.refKind === 'issue' ? 'issue' : 'pr', failed = j.status !== 'completed';
      return { key: `done:${j.id}`, number: f.ref, kind, name: nameOf(kind, f.ref), url: urlOf(kind, f.ref), type: f.kind, typeLabel: TYPE_LABEL[f.kind] || f.kind, state: failed ? 'failed' : 'done', at: j.updatedAt, reason: failed ? `${TYPE_LABEL[f.kind] || f.kind} ended ${j.status}` : `${TYPE_LABEL[f.kind] || f.kind} finished` };
    });
    return { role, label: ROLE_LABEL[role], slots: roleCount(L, role), done, running: mine.filter(i => ['running', 'retry'].includes(i.state)), next: flow.slice(0, STRIP_NEXT), more: Math.max(0, flow.length - STRIP_NEXT),
      waitingForYou: mine.filter(i => i.needsMe && i.state !== 'running') };
  });
  const enough = items.slice(0, MAX_ITEMS);
  return { generatedAt: now, estimateNote: ESTIMATE_NOTE, total, truncated: Math.max(0, total - enough.length), items: enough, groups, lanes,
    medians: Object.fromEntries(Object.entries(med).filter(([, v]) => v && v.n).map(([t, v]) => [t, { ms: v.ms, samples: v.n }])), nextTickAt: fin(nextTickAt) ? nextTickAt : null };
}
