// Project and role policy for a supervised agent, through the same provider-neutral contract the interactive launcher uses
// (tools/policy-delivery.mjs in AI-Rules). Opt-in: with no settings file an adapter keeps its context-level policy, so merging or
// installing this changes nothing until the deployed policy tree carries the contract and the homeowner enables it. Once enabled it
// fails closed. Issue and PR text never reach it: the request is built only from the job's role, kind and worktree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CONTRACT_VERSION = 1;
const PROJECT_FOR_ROLE = {
  devtest: 'DevTest-Infrastructure', implementer: 'squiggleos', overseer: 'squiggleos', unraid: 'unraid',
  'home-assistant': 'home-assistant-yaml', firewall: 'firewall'
};

export class PolicyRefused extends Error {}

export function policyRoleFor(job) {
  if (job.kind === 'review') return 'reviewer';
  if (job.kind === 'rebase') return 'rebaser';
  if (job.kind === 'inbox' || job.role === 'overseer') return 'overseer';
  return 'implementer';
}

export function policySettings(env = process.env) {
  const stateRoot = env.AI_SUPERVISOR_STATE_ROOT || '/mnt/cache/ai-supervisor';
  const file = env.AI_SUPERVISOR_POLICY_SETTINGS || path.join(stateRoot, 'policy-delivery.json');
  if (!fs.existsSync(file)) return null;
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new PolicyRefused(`policy settings are unreadable: ${error.message}`);
  }
  const roots = settings?.authorizedRoots;
  const validRoots = Array.isArray(roots) && roots.length > 0 && roots.every(root => typeof root === 'string' && path.isAbsolute(root));
  if (typeof settings?.policyRoot !== 'string' || !path.isAbsolute(settings.policyRoot) || !validRoots) {
    throw new PolicyRefused('policy settings need an absolute policyRoot and authorizedRoots');
  }
  return settings;
}

function requestArguments(job, provider, settings) {
  const project = Object.hasOwn(PROJECT_FOR_ROLE, job.role) ? PROJECT_FOR_ROLE[job.role] : null;
  if (!project) throw new PolicyRefused(`no policy project for role ${JSON.stringify(job.role)}`);
  return [
    '--contract', String(CONTRACT_VERSION), '--provider', provider, '--project', project, '--role', policyRoleFor(job),
    '--workspace', job.worktree, ...settings.authorizedRoots.flatMap(root => ['--authorized-root', root]),
    '--policy-root', settings.policyRoot, '--format', 'json'
  ];
}

function runContract(tool, args, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-supervisor-policy-'));
  try {
    const textFile = path.join(dir, 'policy');
    const result = spawnSync(process.execPath, [tool, ...args, '--text-file', textFile], { encoding: 'utf8', timeout: 60000 });
    if (result.error) throw new PolicyRefused(`policy tool did not run: ${result.error.message}`);
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch (error) {
      throw new PolicyRefused(`policy tool gave no report (${result.stderr.trim() || error.message})`);
    }
    const reasons = (report.refusals || []).join('; ') || 'no reason given';
    if (report.status !== 'ready' || result.status !== 0) throw new PolicyRefused(`refused by ${settings.policyRoot}: ${reasons}`);
    return { ...report, text: fs.existsSync(textFile) ? fs.readFileSync(textFile, 'utf8') : null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Null when not enabled. `delivery` is the mechanism the calling adapter implements; a registry that declares another one is refused.
export function deliveredPolicy(job, provider, delivery, env = process.env) {
  const settings = policySettings(env);
  if (!settings) return null;
  const tool = path.join(settings.policyRoot, 'tools/policy-delivery.mjs');
  if (!fs.existsSync(tool)) throw new PolicyRefused(`policy delivery tool is missing: ${tool}`);
  const report = runContract(tool, requestArguments(job, provider, settings), settings);
  if (report.delivery !== delivery) throw new PolicyRefused(`no launch mechanism for policy delivery ${JSON.stringify(report.delivery)}`);
  return report;
}

// Preflight outcome: true, or a distinct refusal so a policy problem is never reported as a sign-in problem.
export function policyPreflight(job, provider, delivery, env = process.env) {
  try {
    deliveredPolicy(job, provider, delivery, env);
    return true;
  } catch (error) {
    if (!(error instanceof PolicyRefused)) throw error;
    console.error(`policy delivery refused for ${job.role}/${provider}: ${error.message}`);
    return 'policy_refused';
  }
}
