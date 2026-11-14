import fs from 'node:fs';
import path from 'node:path';
import { rearmView } from './faultview.mjs';
import { ciRerunStats } from './cirerun.mjs';

// Issue #995: job liveness (limit and last activity per running job), retry counts by cause, and what a recovery re-armed.
export function robustnessView(state, team, jobs, now) {
  const live = team.livenessView?.() || { limitMs: 0, running: {}, cancelled: [] };
  const running = (jobs || []).filter(j => j.status === 'running').map(j => {
    const id = String(j.id).slice(0, 8), at = live.running?.[id]?.lastActivityAt ?? null;
    return { id, kind: j.kind ?? null, lastActivityAt: at, idleMs: Number.isFinite(at) ? Math.max(0, now - at) : null };
  });
  const retries = Object.entries(state.sameCause || {}).map(([k, v]) => ({ key: k, cause: v.cause, count: v.count, capped: (team.retryCapItems?.() || []).some(i => i.subject === k.slice(k.indexOf(':') + 1) && i.type === k.slice(0, k.indexOf(':'))) }));
  const rearm = state.rearm || null, up = (() => { try { return JSON.parse(fs.readFileSync(path.join(team.root || '', 'team', 'self-upgrade.json'), 'utf8')).rearmed || null; } catch { return null; } })();
  return {
    limitMinutes: Math.round((live.limitMs || 0) / 60000),
    running,
    cancelled: (live.cancelled || []).slice(-5),
    retries,
    rearm: rearmView(rearm, up),
    infraFaults: team.faults?.summary?.() ?? null,
    ciReruns: ciRerunStats(state),   // issue #1375: reruns of a failed CI check and their results
  };
}
