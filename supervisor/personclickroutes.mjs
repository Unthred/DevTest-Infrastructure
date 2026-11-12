// The dashboard posts that only a person's click may make and that merely leave a request file for the next tick (D-029 write protection):
// Resume on the circuit breaker (issue #626) and Mark done on a homeowner step (issue #1155). Moved out of dashserver.mjs so the server's
// handler does not grow; the helpers are the server's own, handed in. Neither route edits Foreman's state.
import { proofValid, reserveCooldown, releaseCooldown } from './dashwrite.mjs';
import { BREAKER_RESUME_COOLDOWN_MS, requestBreakerResume } from './breakerresume.mjs';
import { requestStepDone } from './pendingstepssync.mjs';
import { isLocalPeer } from './peerpid.mjs';
import { readTeamState } from './dashdata.mjs';

const TEXT = 'text/plain; charset=utf-8';

// d: { root, allowedHost, originAllowed, refuseHost, refuseOrigin, tooLarge, badProof, supervised, peerPid, now, wake, source, store }
export function personClickRoutes(d) {
  const { root } = d;
  // Host, origin, a person's click (the browser marks a click on a form button as a same-origin user navigation, which a script does not send
  // unless it forges it; a dashboard under a supervised job refuses) and the secret proof. Returns the form, or null after answering.
  const personForm = async (req, send, refusal) => {
    if (req.headers.host !== d.allowedHost) { d.refuseHost(req, send); return null; }
    if (!d.originAllowed(req)) { d.refuseOrigin(req, send); return null; }
    if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-user'] !== '?1' || d.supervised()) { send(403, TEXT, refusal); return null; }
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024) { d.tooLarge(send); return null; } chunks.push(c); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (!proofValid(root, form.get('proof'))) { d.badProof(send); return null; }
    return form;
  };
  const wakeTick = () => { try { d.wake(root, 'approve', d.source()); } catch { /* the schedule is the fallback */ } };

  // Resume (issue #626): the circuit breaker's button, with a cooldown. The tick clears the halt.
  const breakerResume = async (req, res, send) => {
    const form = await personForm(req, send, 'resume needs a person clicking the button');
    if (!form) return;
    const scope = form.get('scope') || '', halts = readTeamState(root)?.breaker || {};
    const known = scope === 'all' ? !!(halts.global || Object.keys(halts.halts || {}).length) : scope === 'global' ? !!halts.global : !!(halts.halts || {})[scope];
    if (!known) return send(409, TEXT, 'nothing halted for that scope');
    const t = d.now(), slot = reserveCooldown(root, 'breaker-resume', t, BREAKER_RESUME_COOLDOWN_MS);
    if (!slot.ok) return send(303, TEXT, 'too soon', { location: '/?notice=breaker-resume-cooldown', 'retry-after': String(Math.max(1, Math.ceil((slot.retryAt - t) / 1000))) });
    // Issue #737: a request from this machine must not come from a process that descends from a supervised job. A caller that cannot be
    // identified is refused rather than assumed to be a person. Issue #821: the /proc scan is slow, so it runs only for a request that passed
    // every other check. A refused caller gives the slot back so it cannot lock a person out.
    if (isLocalPeer(req.socket)) {
      const pid = d.peerPid(req.socket);
      if (!pid || d.supervised({ env: {}, pid })) {
        releaseCooldown(root, 'breaker-resume', t);
        return send(403, TEXT, pid ? 'resume needs a person clicking the button' : 'resume refused: the calling process could not be identified');
      }
    }
    requestBreakerResume(root, scope, t);
    wakeTick();
    d.store.invalidate();
    return send(303, TEXT, 'requested', { location: '/' });
  };

  // Mark done (issue #1155): the step must be one the tick recorded and has not yet finished.
  const stepDone = async (req, res, send) => {
    const form = await personForm(req, send, 'marking a step done needs a person clicking the button');
    if (!form) return;
    const pr = Number(form.get('pr')), index = Number(form.get('index'));
    const step = readTeamState(root)?.pendingSteps?.[pr]?.steps?.[index];
    if (!Number.isSafeInteger(pr) || !Number.isSafeInteger(index) || !step || step.done) return send(409, TEXT, 'no such outstanding step');
    if (isLocalPeer(req.socket)) {
      const pid = d.peerPid(req.socket);
      if (!pid || d.supervised({ env: {}, pid })) return send(403, TEXT, 'marking a step done needs a person clicking the button');
    }
    requestStepDone(root, pr, index, d.now());
    wakeTick();
    d.store.invalidate();
    return send(303, TEXT, 'recorded', { location: '/' });
  };
  return { breakerResume, stepDone };
}
