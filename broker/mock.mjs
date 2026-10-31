// Documented dry-run backend for when OpenBao is unavailable. It never asks for, reads or invents a real credential: every
// value is random, generated per call, prefixed so it is recognisable, and valid nowhere.
import crypto from 'node:crypto';
import { BrokerError, safeSecretPath } from './openbao.mjs';

export const MOCK_PREFIX = 'MOCK-NOT-A-SECRET-';

export function createMockBackend({ fields = {} } = {}) {
  return {
    kind: 'mock',
    async assertReadOnly() {},
    async read(secretPath) {
      if (!safeSecretPath(secretPath)) throw new BrokerError('invalid secret path');
      const names = fields[secretPath] ?? ['username', 'password'];
      return { values: Object.fromEntries(names.map(n => [n, `${MOCK_PREFIX}${crypto.randomBytes(12).toString('hex')}`])), leaseId: null };
    },
    async revoke() {}
  };
}
