// Issue #1097: the one US-dollar to pounds conversion, rounded to pence. Pure, no imports and no I/O, so both the dashboard
// (supervisor/money.mjs, which formats it) and the Foreman MCP server (confined to this folder by its permission flags) use
// this single implementation.
// Unknown (null, undefined, NaN, non-numeric) gives null; zero gives 0.
// Issue #1379: the product is trimmed to 12 significant digits before rounding, so 2.82 x 0.75 rounds up to 2.12.
export function gbpAmount(usd, rate) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || !Number.isFinite(rate)) return null;
  // Issue #1433: a tie rounds away from zero for either sign, so a negative amount mirrors the positive one.
  const pence = Math.round(Math.abs(Number((usd * rate * 100).toPrecision(12))));
  return (Math.sign(usd * rate) * pence) / 100 || 0;
}
