// Issue #1097: the one US-dollar to pounds conversion, rounded to pence. Pure, no imports and no I/O, so both the dashboard
// (supervisor/money.mjs, which formats it) and the Foreman MCP server (confined to this folder by its permission flags) use
// this single implementation. Unknown (null, undefined, NaN, non-numeric) gives null; zero gives 0.
export function gbpAmount(usd, rate) { return typeof usd === 'number' && Number.isFinite(usd) && Number.isFinite(rate) ? Math.round(usd * rate * 100) / 100 : null; }
