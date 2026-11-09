// Issue #1107: the part of the team loop that carries out the infrastructure-fault rules of faults.mjs against the state file.
// faults.mjs decides; this file applies: it refunds the attempt a launch counted, parks the agent, probes it without a model call,
// and clears the caps that infrastructure faults set before this version.
import * as faults from './faults.mjs';
import { provider } from './core.mjs';
import { redact } from './redact.mjs';

// Where each job kind counted its attempt at launch (team.mjs bump). `keyOf` is the counter key on the dispatcher's job record.
const byKey = j => j.key;
const COUNTERS = { review: ['reviewAttempts', byKey], fix: ['fixAttempts', byKey], cifix: ['fixAttempts', byKey], rebase: ['rebaseAttempts', byKey], continue: ['continueAttempts', j => j.pr] };

// The cause a work failure is counted under for the retry cap.
export const causeOfEnd = job => String(job.incompleteReason?.cause || job.lastEvent || job.status);

export class FaultFlow {
  // state: () => the team state object; probe: async (agent, cause) => boolean, or null when no model-free check exists.
  constructor({ state, now, save, probe = null }) { this.state = state; this.now = now; this.save = save; this.probe = probe; }
  get infra() { return faults.normalize(this.state().infra ||= {}); }

  // Hand the launch's attempt back (once per job). Only a counter that is above zero moves.
  refund(j) {
    const c = COUNTERS[j.kind];
    if (!c || j.attemptRefunded) return false;
    const map = this.state()[c[0]], key = c[1](j);
    if (!map || key == null || !(map[key] > 0)) return false;
    map[key]--; j.attemptRefunded = 'infrastructure';
    return true;
  }
  // A job ended: when it is an infrastructure fault, record it, park the agent and refund the attempt. Returns the classification.
  onEnd(id, j, job, report) {
    const cls = faults.classifyEnd(job);
    // Issue #1109: a deliberate stop uses no attempt either, but it does not park the agent.
    if (cls.kind === 'none') { if (this.refund(j)) { j.attemptRefunded = cls.cause; (report.stopRefunds ||= []).push({ job: id.slice(0, 8), agent: j.agent }); this.save(); } return cls; }
    if (cls.kind !== 'infra' || j.infraFault) return cls;
    j.infraFault = cls.cause;
    // The agent never started: the issue is queued again (a job that spent tokens may hold partial work, so it keeps the existing path).
    if (j.kind === 'implement' && faults.tokensOf(job) === 0 && Number.isSafeInteger(j.issue)) {
      delete this.state().implemented?.[j.issue];
      j.infraRequeued = true;
    }
    const ref = j.pr != null ? `PR #${j.pr}` : j.issue != null ? `issue #${j.issue}` : null;
    faults.noteFault(this.infra, { agent: j.agent, cause: cls.cause, job: id, ref, now: this.now() });
    const refunded = this.refund(j);
    (report.infraFaults ||= []).push({ job: id.slice(0, 8), agent: j.agent, cause: cls.cause, refunded });
    this.save();
    return cls;
  }
  // Probe every parked agent whose backoff time has come. No model call: the injected probe reads sign-in status or allowance only.
  async probeDue(report) {
    for (const agent of faults.dueProbes(this.infra, this.now())) {
      const rec = this.infra.parked[agent];
      let passed = false;
      try { passed = this.probe ? (await this.probe(agent, rec.cause)) === true : false; } catch { passed = false; }
      const r = faults.noteProbe(this.infra, agent, passed, this.now());
      (report.infraProbes ||= []).push({ agent, passed, ...(r?.nextProbeAt ? { nextProbeAt: r.nextProbeAt } : {}) });
    }
    this.save();
  }
  // Once, on install: caps set by infrastructure faults are cleared, one log line each.
  clearLegacyCaps(cap, log) {
    const s = this.state();
    if (s.infraCapsCleared) return [];
    s.infraCapsCleared = this.now();
    const found = faults.legacyInfraCaps(s.sameCause, cap);
    for (const f of found) {
      delete s.sameCause[f.key];
      log(`cleared the retry cap ${redact(f.key, 60)}: ${f.count} attempts with the infrastructure cause ${redact(f.cause, 40)}`);
    }
    this.save();
    return found;
  }
  // Once, on install (issue #1109): every attempt a finished job used for an infrastructure fault or a stop is released, for every counter,
  // one log line per job. A job that did real work keeps its attempt. Each job is released at most once (attemptRefunded), so a rerun changes nothing.
  async releaseInfraAttempts(getJob, log) {
    const s = this.state();
    if (s.infraAttemptsReleased) return [];
    s.infraAttemptsReleased = this.now();
    const released = [];
    for (const [id, j] of Object.entries(s.jobs || {})) {
      if (!COUNTERS[j.kind] || j.attemptRefunded) continue;
      let job = null;
      try { job = await getJob(id); } catch { job = null; }
      // A missing or unreadable record is classified as infrastructure by faults.classifyEnd(null), so it is released too.
      if (job && !['stopped', 'blocked', 'failed', 'waiting_on', 'completed'].includes(job.status)) continue;
      const cls = faults.classifyEnd(job);
      if (cls.kind === 'work' || !this.refund(j)) continue;
      j.attemptRefunded = cls.cause;
      const ref = j.pr != null ? `PR #${j.pr}` : j.issue != null ? `issue #${j.issue}` : 'no reference';
      released.push({ job: id.slice(0, 8), ref, cause: cls.cause });
      log(`released the ${j.kind} attempt of job ${id.slice(0, 8)} on ${ref}: it ended on ${redact(cls.cause, 40)}, not on the work`);
    }
    this.save();
    return released;
  }
  // Once per ingest pass: probe the parked agents that are due, and (once, on install) clear the caps faults set earlier.
  async step(report, cap, getJob = null) {
    if (getJob) await this.releaseInfraAttempts(getJob, line => (report.infraAttemptsReleased ||= []).push(line));
    await this.probeDue(report);
    const cleared = this.clearLegacyCaps(cap, line => (report.infraCapsCleared ||= []).push(line));
    if (cleared.length) this.save();
  }
  items() { return faults.attentionItems(this.infra, this.now(), faults.fixOf); }
  parked(agent) { return faults.isParked(this.infra, agent) ? this.infra.parked[agent] : null; }
  summary() { return faults.summary(this.state().infra || {}, this.now()); }
}

// The planner's view of an agent: a parked agent is out, with the reason, exactly as an agent out of allowance is.
export function withParking(limitedOf, flow) {
  return (agent, ...rest) => {
    const rec = flow.parked(agent);
    const base = limitedOf(agent, ...rest);
    return rec && !base?.out ? { ...(base || {}), out: true, reason: `parked: ${faults.INFRA_LABEL[rec.cause] || rec.cause}`, parked: true } : base;
  };
}

// The model-free check of a parked agent: the provider adapter's own preflight (sign-in status, launcher), run against the repository.
// Gives the team its probe and returns the team, so the caller stays one expression.
export function attachProbe(team, registry, config) {
  team.faults.probe = async agent => {
    const { adapter } = await provider(registry, config.agents[agent].provider);
    return adapter.preflight?.({ role: 'devtest', worktree: config.repo_path }) === true;
  };
  return team;
}
