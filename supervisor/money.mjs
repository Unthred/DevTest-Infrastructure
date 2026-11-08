// Issue #1097: the one place a job cost is converted and formatted. The agent CLIs report cost in US dollars (a usage
// equivalent, not a charge) and the stored job records keep that figure unchanged; only display converts it, with one
// configured rate (`display.gbp_per_usd` in team.json or team.local.json). No live exchange-rate lookup.
export const DEFAULT_GBP_PER_USD = 0.75;
export const DISPLAY_DEFAULTS = Object.freeze({ gbp_per_usd: DEFAULT_GBP_PER_USD });

export function validateDisplay(d) {
  if (d === undefined) return { ...DISPLAY_DEFAULTS };
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => k !== 'gbp_per_usd')) throw new Error('invalid team config: display');
  const out = { ...DISPLAY_DEFAULTS, ...d };
  if (!(typeof out.gbp_per_usd === 'number' && Number.isFinite(out.gbp_per_usd) && out.gbp_per_usd > 0 && out.gbp_per_usd <= 10)) throw new Error('invalid team config: display.gbp_per_usd');
  return out;
}

let current = DEFAULT_GBP_PER_USD;   // set by the dashboard server from the configuration it serves
export function configureDisplay(display) { current = validateDisplay(display).gbp_per_usd; return current; }
export const displayRate = () => current;

const ok = n => typeof n === 'number' && Number.isFinite(n);

// A US dollar amount as pounds rounded to pence, or null when the cost is unknown.
export function gbpAmount(usd, rate = current) { return ok(usd) ? Math.round(usd * rate * 100) / 100 : null; }

// A US dollar amount shown as pounds: "£1.52". Unknown (null, undefined, NaN) shows `unknown`, default an en dash; zero shows £0.00.
export function formatCost(usd, { rate = current, unknown = '–' } = {}) {
  const g = gbpAmount(usd, rate);
  return g === null ? unknown : `£${g.toFixed(2)}`;
}
