// Token and cost figures from the providers' own structured output (issue #32). Counts only: no message text is read.
// Claude Code: the final `result` line carries `usage` and `total_cost_usd`. Codex exec: each `turn.completed` carries `usage`.
// Codex input_tokens already includes cached_input_tokens (a subset, not added); Claude cache_creation/cache_read are separate and added.
// The cost is the CLI's own estimate for the subscription session, not a bill.
const count = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
export function usageFromLine(line) {
  if (typeof line !== 'string' || !line.startsWith('{')) return null;
  let o; try { o = JSON.parse(line); } catch { return null; }
  if (!o || !['result', 'turn.completed'].includes(o.type) || !o.usage || typeof o.usage !== 'object') return null;
  const u = o.usage;
  const input = count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens);
  const output = count(u.output_tokens);
  const cost = Number.isFinite(o.total_cost_usd) && o.total_cost_usd >= 0 ? o.total_cost_usd : null;
  return { inputTokens: input, outputTokens: output, costUsdEstimate: cost };
}
export function addUsage(a, b) {
  if (!b) return a || null;
  if (!a) return { ...b };
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    costUsdEstimate: a.costUsdEstimate === null && b.costUsdEstimate === null ? null : (a.costUsdEstimate || 0) + (b.costUsdEstimate || 0) };
}
