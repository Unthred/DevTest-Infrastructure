export const capabilities = { resumeSession: false, usageReset: false };
export function preflight() { return true; }
export function contextForRole(role) {
  const contexts = { devtest: 'unraid', unraid: 'unraid', implementer: 'unraid', overseer: 'unraid', 'home-assistant': 'home-assistant', firewall: 'firewall' };
  if (!contexts[role]) throw new Error('unsupported launcher role');
  return contexts[role];
}
export function command(config, job, resume) {
  return [...config.command, ...(config.arguments || []), ...(resume && job.sessionId ? [...(config.resumeArguments || []), job.sessionId] : [])];
}
export function observe(line) {
  const text = line.toLowerCase();
  if (/permission required|approval required|requires approval/.test(text)) return { event: 'approval_required' };
  if (/authentication failed|not logged in|unauthorized|invalid api key/.test(text)) return { event: 'auth_error' };
  if (/context window|context length|maximum context/.test(text)) return { event: 'context_limit' };
  if (/network error|connection reset|econnreset|enotfound/.test(text)) return { event: 'network_error' };
  if (/rate limit|\b429\b/.test(text)) return { event: 'transient_rate_limit' };
  return {};
}
export function resetTime(line) {
  const match = line.match(/(?:resets? (?:at|on)|try again (?:at|after))\s+(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))/i);
  if (!match) return null;
  const time = Date.parse(match[1]);
  return Number.isFinite(time) ? time : null;
}
// Access arguments come from the manifest (D-012: no provider branches in core). Unknown modes yield none.
export function accessArgs(config, job) { return config.manifest?.access?.[job.access || 'standard'] || []; }
