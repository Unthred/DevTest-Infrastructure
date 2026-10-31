import path from 'node:path';
import { buildCommand } from './commands.mjs';
import { createPlan, runContainer } from '../docker/runner.mjs';

// Trusted host-side integration point: callers still provide policy/configuration,
// while Docker execution, image pinning, mounts, limits and cleanup stay in runner.mjs.
export function dotnetRunSpec(options) {
  if (typeof options.projectRoot !== 'string' || !path.isAbsolute(options.projectRoot)) throw new TypeError('absolute projectRoot is required');
  const planned = buildCommand(options);
  if (!options.runId) throw new TypeError('runId is required');
  return {
    spec: {
      project: options.projectRoot,
      runId: options.runId,
      image: `dotnet-${planned.sdk}`,
      phase: planned.phase,
      cacheName: `nuget-sdk-${planned.sdk}`,
      command: planned.command
    },
    command: planned
  };
}

export function createDotnetPlan(options, config) {
  const { spec, command } = dotnetRunSpec(options);
  const plan = createPlan({
    ...spec
  }, config);
  return { ...plan, dotnet: command };
}

export async function runDotnet(options, config, runner = runContainer) {
  const plan = createDotnetPlan(options, config);
  return { plan, result: await runner(plan) };
}
