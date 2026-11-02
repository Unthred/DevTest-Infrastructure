// Host-side gate for the LIVE Home Assistant run (issue #10, D-008, D-009, D-022, OQ-2). Pure: it reads nothing secret and opens no
// connection. It answers one question: may a live run start? Today the answer is "blocked", and the reasons say why, so live
// acceptance is reported blocked rather than invented.
import { validatePolicy, assertAllowed, readDecisionRegister } from '../broker/broker.mjs';

export const LIVE_ENTRY = 'ha-test-login';
export const LIVE_HOST = 'home.yeradonkey.com';

// networkRoute: 'available' only when an enforced route to exactly the declared host exists. The runner offers none (OQ-2), so
// callers pass 'unavailable' today; the parameter exists so the gate stays honest when a later, separately approved route lands.
export function evaluateLiveGate({ policy, entry = LIVE_ENTRY, register = readDecisionRegister(), networkRoute = 'unavailable' } = {}) {
  const reasons = [];
  let valid = true;
  try { validatePolicy(policy); } catch (error) { valid = false; reasons.push(`credential policy unusable: ${error.message}`); }
  if (valid) {
    try {
      const e = assertAllowed(policy, entry, register);
      if (!e.domains.includes(LIVE_HOST)) reasons.push(`secret ${entry} is not scoped to ${LIVE_HOST}`);
    } catch (error) { reasons.push(error.message); }
  }
  if (networkRoute !== 'available') reasons.push('no enforced network route to the Home Assistant host: browser runs reach only host-side Unix-socket targets (OQ-2); a TCP route needs a firewall or forwarder change, which requires fresh explicit homeowner approval');
  return { status: reasons.length ? 'blocked' : 'ready', host: LIVE_HOST, reasons };
}
