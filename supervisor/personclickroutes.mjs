// Mark done on a homeowner step (issue #1155): a dashboard post that only a person's click may make and that merely leaves a request file for
// the next tick (D-029 write protection). It lives apart from dashserver.mjs so the server's handler does not grow. It never edits Foreman's state.
import { proofValid } from './dashwrite.mjs';
import { requestStepDone } from './pendingstepssync.mjs';
import { isLocalPeer } from './peerpid.mjs';
import { readTeamState } from './dashdata.mjs';

const TEXT = 'text/plain; charset=utf-8';
const REFUSAL = 'marking a step done needs a person clicking the button';

// d: { root, allowedHost, originAllowed, refuseHost, refuseOrigin, tooLarge, badProof, supervised, peerPid, now, wake, source, store }
export function stepDoneRoute(d) {
  const { root } = d;
  // Host, origin, a person's click (the browser marks a click on a form button as a same-origin user navigation, which a script does not send
  // unless it forges it; a dashboard under a supervised job refuses) and the secret proof. Returns the form, or null after answering.
  const personForm = async (req, send) => {
    if (req.headers.host !== d.allowedHost) { d.refuseHost(req, send); return null; }
    if (!d.originAllowed(req)) { d.refuseOrigin(req, send); return null; }
    if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-user'] !== '?1' || d.supervised()) { send(403, TEXT, REFUSAL); return null; }
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1024) { d.tooLarge(send); return null; }
      chunks.push(c);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (!proofValid(root, form.get('proof'))) { d.badProof(send); return null; }
    return form;
  };

  // The step must be one the tick recorded and has not yet finished.
  return async (req, res, send) => {
    const form = await personForm(req, send);
    if (!form) return;
    const pr = Number(form.get('pr'));
    const index = Number(form.get('index'));
    const step = readTeamState(root)?.pendingSteps?.[pr]?.steps?.[index];
    if (!Number.isSafeInteger(pr) || !Number.isSafeInteger(index) || !step || step.done) return send(409, TEXT, 'no such outstanding step');
    if (isLocalPeer(req.socket)) {
      const pid = d.peerPid(req.socket);
      if (!pid || d.supervised({ env: {}, pid })) return send(403, TEXT, REFUSAL);
    }
    requestStepDone(root, pr, index, d.now());
    try { d.wake(root, 'approve', d.source()); } catch { /* the schedule is the fallback */ }
    d.store.invalidate();
    return send(303, TEXT, 'recorded', { location: '/' });
  };
}
