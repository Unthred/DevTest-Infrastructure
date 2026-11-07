// One supported route to install a commit the automatic upgrader refuses (issue #446), e.g. a change to
// tools/bootstrap-install.sh. `ai-supervisor self-upgrade hand-install SHA`. Every external effect is an injected dep, so each
// rule is tested with fakes. It never touches team.local.json: the pause is a hold file, so the config is byte-identical after.
//
// Hold file (team/hand-install.hold): while it is live, the team tick starts nothing, the self-upgrade step does nothing, and the
// reconciler restarts no paused or queued job (`enabled: false` stops only the first). A due restart is therefore not lost: its
// record stays and it restarts on the first reconcile after the hold is gone. A hold is live only while its owner process runs and
// it is younger than HOLD_MAX_MS, so a crashed run can never hold the team: the next reconcile simply resumes.
// Journal (team/hand-install.json): the phase of the run in progress. A later run (or `recover`) finds an unfinished one and, if the
// new version was swapped in but not verified, rolls back to the recorded old version first.
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './core.mjs';
import { shortCommit } from './naming.mjs';
import { redact } from './redact.mjs';
import { liveTickOutcome, handInstallCommand } from './upgrade.mjs';

const SHA = /^[0-9a-f]{40}$/;
export const HOLD_MAX_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_DRAIN_MS = 30 * 60 * 1000;
const holdFile = root => path.join(root, 'team', 'hand-install.hold');
const journalFile = root => path.join(root, 'team', 'hand-install.json');
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// The live hold, or null. Read by the tick, the self-upgrade step and the reconciler; a stale or ownerless hold is not live.
export function handInstallHold(root, { now = Date.now(), alive = pidAlive } = {}) {
  let h; try { h = JSON.parse(fs.readFileSync(holdFile(root), 'utf8')); } catch { return null; }
  if (!h || !Number.isFinite(h.at) || now - h.at >= HOLD_MAX_MS) return null;
  if (Number.isSafeInteger(h.pid) && !alive(h.pid)) return null;
  return h;
}
const writeHold = (root, h) => { fs.mkdirSync(path.join(root, 'team'), { recursive: true, mode: 0o700 }); atomicJson(holdFile(root), h); };
const dropHold = root => fs.rmSync(holdFile(root), { force: true });
const readJournal = root => { try { return JSON.parse(fs.readFileSync(journalFile(root), 'utf8')); } catch { return null; } };
const writeJournal = (root, j) => { fs.mkdirSync(path.join(root, 'team'), { recursive: true, mode: 0o700 }); atomicJson(journalFile(root), j); };

export { handInstallCommand };

// deps: installed(), activeJobs() (jobs that are running), dueHeld() (paused/queued jobs whose restart is due), install(sha) ->
// {ok, tests?, reason?, kind?}, dryRunTick(), restartDashboard(sha), dashboardAnswers() -> {local, public: true|false|null},
// liveTick() -> the tick report, rollback(from, to), record(entry), sleep(ms), now()
export async function handInstall({ root, sha, deps, say = () => {}, drainMaxMs = DEFAULT_DRAIN_MS, pollMs = 5000, pid = process.pid }) {
  const d = deps;
  const phase = (n, text) => say(`[${n}/8] ${text}`);
  const phases = [];
  const finish = (result, text, extra = {}) => { say(`RESULT: ${result}: ${text}`); return { result, text, phases, ...extra }; };
  if (!SHA.test(sha || '')) return finish('refused', 'give the exact full 40-character commit SHA', { ok: false });
  // An unfinished earlier run: undo an unverified swap, then drop its hold, before anything else.
  const old = readJournal(root);
  if (old && old.phase !== 'done') {
    const live = old.pid && old.pid !== pid && pidAlive(old.pid) && handInstallHold(root, { now: d.now() });
    if (live) return finish('refused', 'another hand-install is running', { ok: false });
    phase(0, `an earlier run stopped in phase ${old.phase}; recovering`);
    if (old.to && d.installed() === old.to && old.from && old.from !== old.to) {
      const rb = await d.rollback(old.from, old.to).catch(error => ({ ok: false, reason: String(error?.message || error) }));
      if (!rb.ok || d.installed() !== old.from) { dropHold(root); return finish('rollback-failed', `recovery could not restore ${shortCommit(old.from)}: manual repair needed`, { ok: false }); }
      d.record({ from: old.from, to: old.to, result: 'rolled_back', reason: 'hand-install interrupted; rolled back on recovery' });
    }
    dropHold(root); writeJournal(root, { ...old, phase: 'done', recovered: true });
  }

  const from = d.installed();
  if (!SHA.test(from || '')) return finish('refused', 'no installed version to roll back to', { ok: false });
  if (from === sha) return finish('already-installed', `${shortCommit(sha)} is already installed`, { ok: true });

  const journal = (p, extra = {}) => { phases.push(p); writeJournal(root, { from, to: sha, pid, phase: p, at: d.now(), ...extra }); };
  let swapped = false;
  const resume = () => { dropHold(root); };
  const rollback = async why => {
    writeHold(root, { at: d.now(), pid, to: sha });   // no start while the old version is put back
    const rb = await d.rollback(from, sha).catch(error => ({ ok: false, reason: String(error?.message || error) }));
    const back = rb.ok && d.installed() === from;
    if (back) { swapped = false; await d.restartDashboard(from).catch(() => null); }
    d.record({ from, to: sha, result: back ? 'rolled_back' : 'rollback_failed', reason: String(why).slice(0, 200) });
    return back;
  };
  try {
    phase(1, 'pausing new starts and due restarts');
    writeHold(root, { at: d.now(), pid, to: sha });
    journal('hold');

    phase(2, 'draining running jobs');
    journal('drain');
    const start = d.now();
    let running = await d.activeJobs();
    while (running > 0 && d.now() - start < drainMaxMs) { await d.sleep(pollMs); running = await d.activeJobs(); }
    const due = await d.dueHeld();
    if (running > 0) {
      resume(); journal('done');
      return finish('not-installed', `${running} job(s) still running after the drain bound; nothing changed, new starts resumed`, { ok: false, heldRestarts: due });
    }
    if (due > 0) say(`      ${due} paused or queued job(s) are due; their restart waits until the hold ends`);

    phase(3, `installing ${shortCommit(sha)} (validator and full tests)`);
    journal('install');
    const inst = await d.install(sha);
    if (!inst.ok) {
      const installedNow = d.installed();
      if (installedNow === sha) { swapped = true; }   // the swap script failed after moving the link: undo below
      if (!swapped) {
        resume(); journal('done');
        const named = inst.tests?.length ? `failing tests: ${inst.tests.slice(0, 5).join('; ')}` : redact(String(inst.reason || 'install failed'), 300);
        d.record({ from, to: sha, result: 'precheck_failed', reason: named.slice(0, 200) });
        return finish('not-installed', `${named}; nothing was swapped, ${shortCommit(from)} still installed, new starts resumed`, { ok: false, tests: inst.tests || [] });
      }
    } else swapped = true;

    if (swapped && !inst.ok) {
      const back = await rollback(`install failed after the swap: ${inst.reason}`);
      resume(); journal('done');
      return finish(back ? 'rolled-back' : 'rollback-failed', back ? `install failed (${redact(String(inst.reason || ''), 200)}); ${shortCommit(from)} restored and confirmed, new starts resumed` : 'install failed and the old version could NOT be confirmed: manual repair needed', { ok: false });
    }

    const verify = async (n, label, fn) => {
      phase(n, label);
      journal(label.split(' ')[0]);
      let r; try { r = await fn(); } catch (error) { r = { ok: false, reason: String(error?.message || error).slice(0, 200) }; }
      return r;
    };
    const checks = [
      [4, 'dry-run tick on the new version', async () => d.dryRunTick()],
      [5, 'restarting the dashboard and checking it answers', async () => {
        const r = await d.restartDashboard(sha);
        if (!r.ok) return { ok: false, reason: `dashboard restart failed: ${r.reason}` };
        const a = await d.dashboardAnswers();
        if (!a.local) return { ok: false, reason: 'dashboard does not answer locally' };
        if (a.public === false) return { ok: false, reason: 'dashboard does not answer publicly' };
        say(`      local answer ok; public answer ${a.public === null ? 'not configured (self_upgrade.public_dashboard_url), not checked' : 'ok'}`);
        return { ok: true };
      }],
      [6, 'releasing the hold', async () => { resume(); return { ok: true }; }],
      [7, 'live tick on the new version', async () => liveTickOutcome(await d.liveTick())]
    ];
    for (const [n, label, fn] of checks) {
      const r = await verify(n, label, fn);
      if (!r.ok) {
        phase(8, `check failed (${redact(String(r.reason || 'error'), 200)}); rolling back`);
        const back = await rollback(`${label} failed: ${r.reason}`);
        resume(); journal('done');
        return finish(back ? 'rolled-back' : 'rollback-failed', back ? `${label} failed (${redact(String(r.reason || 'error'), 200)}); ${shortCommit(from)} restored and confirmed, new starts resumed` : `${label} failed and the old version could NOT be confirmed: manual repair needed`, { ok: false });
      }
    }
    phase(8, 'done');
    d.record({ from, to: sha, result: 'verified', reason: 'hand-install' });
    try { d.noteInstalled?.(); } catch { /* the batching window is a convenience; the install stands */ }   // issue #708
    journal('done');
    return finish('installed', `${shortCommit(sha)} installed and verified (dry-run, dashboard, live tick); new starts resumed`, { ok: true });
  } catch (error) {
    // Whatever went wrong, new starts resume; an unverified swap is undone.
    let back = !swapped;
    if (swapped) back = await rollback(`hand-install error: ${error?.message}`).catch(() => false);
    resume(); try { journal('done'); } catch { /* the hold is already gone */ }
    return finish(back ? 'rolled-back' : 'rollback-failed', `${redact(String(error?.message || error), 200)}; ${back ? `${shortCommit(from)} confirmed` : 'old version NOT confirmed: manual repair needed'}; new starts resumed`, { ok: false });
  } finally { resume(); }
}
