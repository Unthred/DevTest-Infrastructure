// Team configuration: validation of team.json and its local override, and loading (issue #1239, moved out of team.mjs unchanged).
// team.mjs re-exports every name here, so importers keep using './team.mjs'.
import fs from 'node:fs';
import path from 'node:path';
import { SupervisorError } from './core.mjs';
import * as robust from './robust.mjs';
import { validateBreakerConfig } from './breaker.mjs';
import { validateAlertsConfig } from './alert.mjs';
import { configureDisplay, validateDisplay } from './money.mjs';
import { validateResourceConfig } from './resources.mjs';
import { validateModelsConfig, mergeModelsConfig } from './models.mjs';
import { validateBudgetConfig } from './budget.mjs';
import { ORIGIN_PATTERN } from './hostvalue.mjs';
import { hostPressureConfig } from './hostpressure.mjs';
import { validateChangeCheck } from './ghchange.mjs';
import { validateHealthConfig } from './hostdisk.mjs';
import { assertGithubApp, withHostGithubApp } from './appidentity.mjs';

// Issue #379: validation does not mutate its input; it normalizes a copy (limits.roles, deprecations) and returns it.
export function validateTeamConfig(input) {
  const c = structuredClone(input);
  if (c?.schema_version !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(c.repository || '') || !path.isAbsolute(c.repo_path || '') || !path.isAbsolute(c.worktree_base || ''))
    throw new SupervisorError('invalid team config: schema, repository or paths');
  const L = c.limits || {};
  for (const k of ['max_review_attempts', 'max_fix_attempts']) if (!Number.isSafeInteger(L[k]) || L[k] < 1 || L[k] > 8) throw new SupervisorError(`invalid team limit: ${k}`);
  // Issue #344: no fixed ceiling on concurrency. `overall` is optional; absent, it follows the role counts (see overallCap).
  if ('overall' in L && !(Number.isSafeInteger(L.overall) && L.overall >= 1)) throw new SupervisorError('invalid team limit: overall');
  if ('review_starvation_hours' in L && !(typeof L.review_starvation_hours === 'number' && L.review_starvation_hours > 0 && L.review_starvation_hours <= 720)) throw new SupervisorError('invalid team limit: review_starvation_hours');
  if ('idle_minutes' in L && !(typeof L.idle_minutes === 'number' && L.idle_minutes > 0 && L.idle_minutes <= 10080)) throw new SupervisorError('invalid team limit: idle_minutes');
  if ('chain_seconds' in L && !(typeof L.chain_seconds === 'number' && L.chain_seconds >= 0 && L.chain_seconds <= 3600)) throw new SupervisorError('invalid team limit: chain_seconds');
  if ('test_slots' in L && !(Number.isSafeInteger(L.test_slots) && L.test_slots >= 1 && L.test_slots <= 8)) throw new SupervisorError('invalid team limit: test_slots');
  if ('test_reuse_hours' in L && !(Number.isSafeInteger(L.test_reuse_hours) && L.test_reuse_hours >= 0 && L.test_reuse_hours <= 720)) throw new SupervisorError('invalid team limit: test_reuse_hours');
  if ('test_concurrency' in L && !(Number.isSafeInteger(L.test_concurrency) && L.test_concurrency >= 1 && L.test_concurrency <= 32)) throw new SupervisorError('invalid team limit: test_concurrency');
  if ('test_tmp_root' in c && !(typeof c.test_tmp_root === 'string' && path.isAbsolute(c.test_tmp_root))) throw new SupervisorError('invalid team config: test_tmp_root must be an absolute path');
  if ('reports_dir' in c && !(typeof c.reports_dir === 'string' && path.isAbsolute(c.reports_dir))) throw new SupervisorError('invalid team config: reports_dir must be an absolute path');   // issue #882
  if ('test_resources' in c) validateResourceConfig(c.test_resources);
  if ('chain_passes' in L && !(Number.isSafeInteger(L.chain_passes) && L.chain_passes >= 0 && L.chain_passes <= 8)) throw new SupervisorError('invalid team limit: chain_passes');
  if ('chain_poll_seconds' in L && !(typeof L.chain_poll_seconds === 'number' && L.chain_poll_seconds >= 1 && L.chain_poll_seconds <= 300)) throw new SupervisorError('invalid team limit: chain_poll_seconds');
  if ('stall_hours' in L && !(typeof L.stall_hours === 'number' && L.stall_hours > 0 && L.stall_hours <= 720)) throw new SupervisorError('invalid team limit: stall_hours');
  try { robust.validateRobustLimits(L); } catch (error) { throw new SupervisorError(error.message); }   // issue #995
  normalizeRoleLimits(c);
  if ('inbox_max_minutes' in L && !(Number.isFinite(L.inbox_max_minutes) && L.inbox_max_minutes >= 1 && L.inbox_max_minutes <= 720)) throw new SupervisorError('invalid team limit: inbox_max_minutes');   // issue #971
  if ('max_open_prs' in L && !(Number.isSafeInteger(L.max_open_prs) && L.max_open_prs >= 1 && L.max_open_prs <= 100)) throw new SupervisorError('invalid team limit: max_open_prs');
  validateUnblockLimits(L.unblock);
  validateOptionalSections(c);
  try { validateChangeCheck(c.change_check); } catch (error) { throw new SupervisorError(error.message); }   // issue #755
  try { c.breaker = validateBreakerConfig(c.breaker); } catch (error) { throw new SupervisorError(error.message); }   // issue #549
  validateDashboard(c.dashboard);
  try { c.display = validateDisplay(c.display); } catch (error) { throw new SupervisorError(error.message); }   // issue #1097
  if (c.health?.volumes !== undefined) { try { validateHealthConfig(c.health); } catch (error) { throw new SupervisorError(error.message); } }   // issue #1092
  validateHealth(c.health);   // issue #1093
  // Issue #418: an owner-account comment on a PR requests the re-review. Off unless enabled; enabling it is only safe once agents
  // post under their own GitHub identity (#377): until then a comment from the owner account cannot be told from an agent's.
  if (c.inbox !== undefined && !(c.inbox && typeof c.inbox === 'object' && !Array.isArray(c.inbox) && typeof c.inbox.dir === 'string' && path.isAbsolute(c.inbox.dir) && Object.keys(c.inbox).every(k => k === 'dir' || k === 'max_pending') && (c.inbox.max_pending === undefined || (Number.isSafeInteger(c.inbox.max_pending) && c.inbox.max_pending >= 1 && c.inbox.max_pending <= 200)))) throw new SupervisorError('invalid inbox: { dir: absolute path, max_pending?: 1-200 }');   // issue #124
  if (c.owner_comment_review !== undefined) {
    const o = c.owner_comment_review, login = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(x);
    if (!o || typeof o !== 'object' || typeof o.enabled !== 'boolean' || ('owner' in o && !login(o.owner)) || ('agent_logins' in o && !(Array.isArray(o.agent_logins) && o.agent_logins.every(login))))
      throw new SupervisorError('invalid owner_comment_review: { enabled: boolean, owner?: login, agent_logins?: [login] }');
  }
  const agents = Object.entries(c.agents || {});
  if (agents.length < 1) throw new SupervisorError('team needs at least one agent');
  const seen = new Set();
  for (const [name, a] of agents) {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(name) || !/^[a-z][a-z0-9-]{1,31}$/.test(a.provider || '') || !/^[a-z0-9-]+\/$/.test(a.branch_prefix || '') || !Array.isArray(a.issues) || !a.issues.every(n => Number.isSafeInteger(n) && n > 0))
      throw new SupervisorError(`invalid agent: ${name}`);
    for (const n of a.issues) { if (seen.has(n)) throw new SupervisorError(`issue ${n} has two owners`); seen.add(n); }
  }
  if (new Set(agents.map(([, a]) => a.provider)).size !== agents.length) throw new SupervisorError('two agents share a provider');
  validateModelsConfig(c.models, agents.map(([n]) => n));
  validateBudgetConfig(c.budget, agents.map(([n]) => n));
  if (c.access?.mode === 'full' && c.access.decision !== 'D-020') throw new SupervisorError('full access must cite D-020');
  normalizeReviewConfig(c, agents.map(([n]) => n));
  return c;
}
function validateDashboard(d) {
  if (d === undefined) return;
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => k !== 'allowed_origins')) throw new SupervisorError('invalid team config: dashboard');
  const a = d.allowed_origins;
  if (!Array.isArray(a) || a.length > 10 || !a.every(o => typeof o === 'string' && ORIGIN_PATTERN.test(o) && !/^http:\/\/[^/]*:80$|^https:\/\/[^/]*:443$/.test(o))) throw new SupervisorError('invalid team config: dashboard.allowed_origins must be a list of exact origins such as https://host (no path, no default port, no IPv6 literal)');
}
// Issue #1093: disk warning levels for the Health page, in percent. The alert level must be above the warn level.
export const HEALTH_DEFAULTS = { disk_warn_percent: 85, disk_alert_percent: 95 };
function validateHealth(h) {
  if (h === undefined) return;
  const pct = n => typeof n === 'number' && n > 0 && n <= 100;
  if (!h || typeof h !== 'object' || Array.isArray(h) || Object.keys(h).some(k => k !== 'volumes' && !(k in HEALTH_DEFAULTS))) throw new SupervisorError('invalid team config: health');
  const w = h.disk_warn_percent ?? HEALTH_DEFAULTS.disk_warn_percent, a = h.disk_alert_percent ?? HEALTH_DEFAULTS.disk_alert_percent;
  if (!pct(w) || !pct(a) || w >= a) throw new SupervisorError('invalid team config: health disk levels must be percentages with warn below alert');
}
function validateOptionalSections(c) {
  validateSelfUpgrade(c.self_upgrade); assertGithubApp(c);   // issue #1115
  hostPressureConfig(c.host_pressure);   // issue #1151
}
function validateSelfUpgrade(u) {
  if (u === undefined) return;
  if (!u || typeof u !== 'object' || Array.isArray(u) || Object.keys(u).some(k => !['drain_max_minutes', 'min_install_gap_minutes', 'public_dashboard_url'].includes(k))) throw new SupervisorError('invalid team config: self_upgrade');
  if ('public_dashboard_url' in u && !(typeof u.public_dashboard_url === 'string' && /^https?:\/\/[^\s]+$/.test(u.public_dashboard_url))) throw new SupervisorError('invalid team config: self_upgrade.public_dashboard_url');
  if ('drain_max_minutes' in u && !(Number.isSafeInteger(u.drain_max_minutes) && u.drain_max_minutes >= 1 && u.drain_max_minutes <= 720)) throw new SupervisorError('invalid team config: self_upgrade.drain_max_minutes');
  if ('min_install_gap_minutes' in u && !(Number.isSafeInteger(u.min_install_gap_minutes) && u.min_install_gap_minutes >= 0 && u.min_install_gap_minutes <= 1440)) throw new SupervisorError('invalid team config: self_upgrade.min_install_gap_minutes');
}

// Automatic unblocks (issue #163) are budgeted: per PR (or issue) and per UTC day. A limit is only ever changed by the homeowner.
export const UNBLOCK_DEFAULTS = { per_pr: 4, per_day: 12, cooldown_ms: 600000 };
function validateUnblockLimits(u) {
  if (u === undefined) return;
  if (!u || typeof u !== 'object' || Array.isArray(u) || Object.keys(u).some(k => !(k in UNBLOCK_DEFAULTS))) throw new SupervisorError('invalid team limit: unblock');
  for (const k of ['per_pr', 'per_day']) if (k in u && !(Number.isSafeInteger(u[k]) && u[k] >= 0 && u[k] <= 100)) throw new SupervisorError(`invalid team limit: unblock.${k}`);
  if ('cooldown_ms' in u && !(Number.isSafeInteger(u.cooldown_ms) && u.cooldown_ms >= 0 && u.cooldown_ms <= 86400000)) throw new SupervisorError('invalid team limit: unblock.cooldown_ms');
}
// Concurrency is counted per role (issue #148): limits.roles = { implementer, reviewer }. The old limits.per_agent is accepted for one
// release: it maps to both role slots and leaves a deprecation warning (c.deprecations) that the tick reports. roles wins when both are set.
// Issue #460: a rebase has its own role slot (limits.roles.rebaser, default 1), so it never holds the implementer slot from new work.
// Issue #971: the inbox lane (limits.roles.inbox, default 1) is a slot of its own for approved overseer prompts. It is not counted
// against limits.overall, so a short supervised prompt is never held behind long implement or review jobs.
export const ROLES = ['implementer', 'reviewer', 'rebaser', 'inbox'];
export const OVERALL_ROLES = ROLES.filter(r => r !== 'inbox');
export const DEFAULT_REBASERS = 1;
// The count of a role: the configured one, else 1. limits.roles.rebaser is optional; an absent value is left absent so a config is not rewritten.
export const roleCount = (L, r) => (Number.isSafeInteger(L?.roles?.[r]) ? L.roles[r] : r === 'rebaser' ? DEFAULT_REBASERS : 1);   // rebaser and inbox default to 1
// Issue #344: the one replaceable function that predicts which files an implement job will edit. No model call: it reads the paths the
// issue title and body name. A wrong prediction is safe: two jobs on different branches never share a worktree, and an overlap the
// prediction missed surfaces as a merge conflict, which the existing rebase job resolves in queue order.
export function expectedFiles(issue) {
  const text = `${issue?.title || ''}\n${issue?.body || ''}`;
  const found = text.match(/(?<![\w./-])(?:[\w.-]+\/)+[\w.-]*\w(?![\w/])|(?<![\w./-])[\w-]+\.(?:mjs|js|json|md|yml|yaml|cs|sh|html|css)\b/g) || [];
  return new Set(found.filter(f => /\.\w+$/.test(f)).map(f => f.replace(/^\.\//, '')));
}
// Issue #344: what holds the running count below the sum of the chosen role counts, for the dashboard: an explicit overall limit, or
// the open-PR cap pausing new implement work. Empty when nothing does.
export function capNotes(L, pauseText = null) {
  const sum = OVERALL_ROLES.reduce((n, r) => n + roleCount(L, r), 0), out = [];
  if (Number.isSafeInteger(L?.overall) && L.overall >= 1 && L.overall < sum) out.push(`limits.overall is ${L.overall}, below the ${sum} slots the role counts allow, so at most ${L.overall} jobs run at once`);
  if (pauseText) out.push(`${pauseText}; no new implement job starts while the open-PR cap (limits.max_open_prs) is reached`);
  return out;
}
function normalizeRoleLimits(c) {
  const L = c.limits ||= {}, ok = v => Number.isSafeInteger(v) && v >= 1;   // no upper bound: the count per role is the homeowner's choice (#344)
  // Idempotent on its own output, also after a structuredClone (issue #379): the per_agent text already on a validated config is kept, so
  // a derived roles block is never mistaken for an explicit one. On a raw config, any roles block next to per_agent (even one equal
  // to it) is explicit: roles wins and the text says 'remove it'.
  const prior = Array.isArray(c.deprecations) ? c.deprecations.find(d => typeof d === 'string' && d.startsWith('limits.per_agent')) : undefined;
  c.deprecations = [];
  if ('per_agent' in L) {
    if (!ok(L.per_agent)) throw new SupervisorError('invalid team limit: per_agent');
    c.deprecations.push(prior ?? (L.roles === undefined ? 'limits.per_agent is deprecated: it is mapped to limits.roles { implementer, reviewer }; replace it with limits.roles' : 'limits.per_agent is deprecated and ignored because limits.roles is set; remove it'));
    if (L.roles === undefined) L.roles = { implementer: L.per_agent, reviewer: L.per_agent };
  }
  const R = L.roles;
  // issue #460: rebaser is optional (default 1); implementer and reviewer stay required
  if (!R || typeof R !== 'object' || Array.isArray(R) || Object.keys(R).some(k => !ROLES.includes(k)) || !ROLES.every(k => ok(R[k]) || ((k === 'rebaser' || k === 'inbox') && R[k] === undefined))) throw new SupervisorError('invalid team limit: roles');
  // Issue #402: optional limits.provider_roles { <provider>: { implementer?, reviewer? } }. A provider's count caps its own jobs in that
  // role, so one provider's reviews cannot fill the slot meant for the other. A role it omits is limited only by limits.roles.
  const P = L.provider_roles;
  if (P !== undefined) {
    const providers = new Set(Object.values(c.agents || {}).map(a => a?.provider));
    if (!P || typeof P !== 'object' || Array.isArray(P)) throw new SupervisorError('invalid team limit: provider_roles');
    for (const [prov, r] of Object.entries(P)) {
      if (!providers.has(prov) || !r || typeof r !== 'object' || Array.isArray(r) || !Object.keys(r).length || Object.keys(r).some(k => !ROLES.includes(k)) || !Object.values(r).every(ok))
        throw new SupervisorError(`invalid team limit: provider_roles.${String(prov).slice(0, 32)}`);
    }
  }
}

// Review independence (issue #152, amends D-021): a review is independent when the reviewer's model differs from the model that wrote the
// pull request head, so no provider-based interim mode exists any more. interim_review is accepted for one release (its weekly_at is
// still read as the out-of-allowance threshold) and leaves a deprecation warning; out_of_allowance { weekly_at } replaces it.
// second_opinion { paths: [glob], reviewer: <agent> } is optional: a pull request touching those paths gets one extra review from
// the named agent when its provider differs from the one that wrote the head and it has allowance. Not configured: none.
export function normalizeReviewConfig(c, names) {
  const bad = what => new SupervisorError('invalid ' + what + ' config');
  if (c.interim_review !== undefined) {
    const ir = c.interim_review;
    if (!ir || typeof ir !== 'object' || Array.isArray(ir) || ('weekly_at' in ir && !validFraction(ir.weekly_at))) throw bad('interim_review');
    (c.deprecations ||= []).push('interim_review is retired (issue #152): its enabled flag is ignored once D-024 is approved (until then enabled:false still stops an interim PASS from merging under D-021); use out_of_allowance { weekly_at }');
  }
  const oa = c.out_of_allowance;
  if (oa !== undefined && (!oa || typeof oa !== 'object' || Array.isArray(oa) || Object.keys(oa).some(k => k !== 'weekly_at') || !validFraction(oa.weekly_at))) throw bad('out_of_allowance');
  const so = c.second_opinion;
  if (so !== undefined && (!so || typeof so !== 'object' || Array.isArray(so) || Object.keys(so).some(k => !['paths', 'reviewer'].includes(k))
    || !Array.isArray(so.paths) || !so.paths.length || !so.paths.every(g => typeof g === 'string' && /^[\w.\-*?/]+$/.test(g) && !g.startsWith('/') && !g.includes('..')) || !names.includes(so.reviewer))) throw bad('second_opinion');
}
const validFraction = v => Number.isFinite(v) && v > 0 && v <= 1;
export const weeklyAtOf = c => c.out_of_allowance?.weekly_at ?? c.interim_review?.weekly_at ?? 0.995;
// Path globs: ** crosses directories, * and ? do not.
export function globToRegExp(g) {
  let out = '';
  for (let i = 0; i < g.length; i++) {
    if (g[i] === '*') { if (g[i + 1] === '*') { out += '.*'; i++; if (g[i + 1] === '/') i++; } else out += '[^/]*'; }
    else if (g[i] === '?') out += '[^/]';
    else out += g[i].replace(/[.+^$|(){}\[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}
// Local override (issue #30): <state root>/team.local.json, outside versions/, so upgrades keep it and the installed
// copy is never edited. Only operational knobs may be overridden; repository, paths, providers, access and board come
// from the reviewed file in Git.
export const LOCAL_OVERRIDE = 'team.local.json';
export function applyLocalOverride(shipped, local) {
  if (local == null) return shipped;
  if (typeof local !== 'object' || Array.isArray(local)) throw new SupervisorError('invalid team.local.json: not an object');
  const keys = Object.keys(local).filter(k => k !== 'github_app');   // issue #1115: host-only, never in the public shipped file
  const bad = keys.filter(k => !['enabled', 'limits', 'agents', 'depends_on_overrides', 'alerts', 'models', 'interim_review', 'out_of_allowance', 'budget', 'self_upgrade', 'breaker', 'test_tmp_root', 'reports_dir', 'test_resources', 'inbox', 'change_check', 'dashboard', 'display'].includes(k));
  if (bad.length) throw new SupervisorError(`invalid team.local.json: key not overridable: ${bad[0]}`);
  const out = structuredClone(withHostGithubApp(shipped, local));   // issue #1115
  if ('enabled' in local) { if (typeof local.enabled !== 'boolean') throw new SupervisorError('invalid team.local.json: enabled must be boolean'); out.enabled = local.enabled; }
  if ('test_tmp_root' in local) { if (typeof local.test_tmp_root !== 'string' || !path.isAbsolute(local.test_tmp_root)) throw new SupervisorError('invalid team.local.json: test_tmp_root must be an absolute path'); out.test_tmp_root = local.test_tmp_root; }
  if ('reports_dir' in local) { if (typeof local.reports_dir !== 'string' || !path.isAbsolute(local.reports_dir)) throw new SupervisorError('invalid team.local.json: reports_dir must be an absolute path'); out.reports_dir = local.reports_dir; }   // issue #882
  if ('test_resources' in local) out.test_resources = validateResourceConfig(local.test_resources);
  if ('change_check' in local) { try { validateChangeCheck(local.change_check); } catch (error) { throw new SupervisorError(`invalid team.local.json: ${error.message}`); } out.change_check = { ...(out.change_check || {}), ...local.change_check }; }   // issue #755
  if ('inbox' in local) out.inbox = local.inbox;   // issue #642: validated like the shipped key by validateTeamConfig, which loadTeamConfig runs on the merged result
  if ('breaker' in local) { try { out.breaker = validateBreakerConfig({ ...(out.breaker || {}), ...local.breaker }); } catch (error) { throw new SupervisorError(`invalid team.local.json: ${error.message}`); } }
  if ('display' in local) { try { out.display = validateDisplay({ ...(out.display || {}), ...local.display }); } catch (error) { throw new SupervisorError(`invalid team.local.json: ${error.message}`); } }   // issue #1097
  if ('dashboard' in local) { validateDashboard(local.dashboard); out.dashboard = { ...local.dashboard }; }
  if ('self_upgrade' in local) { validateSelfUpgrade(local.self_upgrade); out.self_upgrade = { ...(out.self_upgrade || {}), ...local.self_upgrade }; }
  if ('alerts' in local) out.alerts = validateAlertsConfig(local.alerts);
  if ('interim_review' in local) {   // retired (issue #152): tolerated so an installed team.local.json keeps working; only weekly_at is read
    const o = local.interim_review;
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(k => !['enabled', 'weekly_at'].includes(k))) throw new SupervisorError('invalid team.local.json: interim_review may set only enabled and weekly_at');
    out.interim_review = { ...(out.interim_review || {}), ...o };
  }
  if ('out_of_allowance' in local) {
    const o = local.out_of_allowance;
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(k => k !== 'weekly_at') || !validFraction(o.weekly_at)) throw new SupervisorError('invalid team.local.json: out_of_allowance may set only weekly_at');
    out.out_of_allowance = { ...(out.out_of_allowance || {}), ...o };
  }
  if ('models' in local) { validateModelsConfig(local.models, Object.keys(out.agents)); out.models = mergeModelsConfig(out.models, local.models); }
  if ('budget' in local) { validateBudgetConfig(local.budget, Object.keys(out.agents)); out.budget = { ...(out.budget || {}), ...local.budget }; }
  if (local.limits) {
    if (typeof local.limits !== 'object' || Array.isArray(local.limits)) throw new SupervisorError('invalid team.local.json: limits');
    out.limits = { ...out.limits, ...local.limits };
    if ('per_agent' in local.limits && !('roles' in local.limits)) delete out.limits.roles;   // a deprecated local per_agent still takes effect over the shipped roles
    else if ('roles' in local.limits) { delete out.limits.per_agent; const base = shipped.limits?.roles ?? ('per_agent' in (shipped.limits || {}) ? { implementer: shipped.limits.per_agent, reviewer: shipped.limits.per_agent } : {});   // an older shipped file with per_agent supplies the roles a partial override leaves out
      out.limits.roles = { ...base, ...local.limits.roles }; }
  }
  if (local.depends_on_overrides) out.depends_on_overrides = { ...out.depends_on_overrides, ...local.depends_on_overrides };
  for (const [name, o] of Object.entries(local.agents || {})) {
    if (!out.agents[name]) throw new SupervisorError(`invalid team.local.json: unknown agent ${name}`);
    const extra = Object.keys(o || {}).filter(k => k !== 'issues');
    if (extra.length) throw new SupervisorError(`invalid team.local.json: agent field not overridable: ${extra[0]}`);
    if ('issues' in o) out.agents[name].issues = o.issues;
  }
  return out;
}
export function loadTeamConfig(shippedFile, root) {
  const shipped = JSON.parse(fs.readFileSync(shippedFile, 'utf8'));
  let local = null;
  try { local = JSON.parse(fs.readFileSync(path.join(root, LOCAL_OVERRIDE), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new SupervisorError(`unreadable ${LOCAL_OVERRIDE}`); }
  const cfg = validateTeamConfig(applyLocalOverride(shipped, local));
  configureDisplay(cfg.display);   // issue #1097: the cost display rate of this process
  return cfg;
}
