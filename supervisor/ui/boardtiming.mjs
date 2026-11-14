// Issue #1315: the timings every board style shares, and the hash that gives a job its own path. No DOM, no clock, no random numbers.
export const MOTION = Object.freeze({
  maxEvents: 12,       // more events than this in one change are shown at once, with a count
  launchMs: 900,
  returnMs: 1800,
  closeUpMs: 400,
  landMinMs: 1500,
  landMaxMs: 3000,
  landBaseMs: 1600,
  landSpreadMs: 1000,
  contacts: 5,         // pegs a land touches, fewer only when the peg board is too small for more
});

// A 32 bit hash of the job id: the only source of variety in a path.
export function hashOf(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text)) hash = Math.imul(hash ^ char.codePointAt(0), 0x01000193) >>> 0;
  return hash;
}

export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
