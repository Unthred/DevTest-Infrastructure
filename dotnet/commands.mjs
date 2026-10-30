import fs from 'node:fs';
import path from 'node:path';

const SDK = new Set(['8', '9', '10']);
const SAFE_VALUE = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
const within = (base, target) => target === base || target.startsWith(base + path.sep);

export class DotnetCommandError extends Error {
  constructor(message) { super(message); this.name = 'DotnetCommandError'; }
}

export function discoverProject(root, workingDirectory = '.') {
  if (!path.isAbsolute(root)) throw new DotnetCommandError('project root must be absolute');
  const realRoot = fs.realpathSync(root);
  const cwd = path.resolve(realRoot, workingDirectory);
  if (!within(realRoot, cwd) || !fs.statSync(cwd).isDirectory()) throw new DotnetCommandError('working directory must be inside the project');
  const actualCwd = fs.realpathSync(cwd);
  if (!within(realRoot, actualCwd)) throw new DotnetCommandError('working directory resolves outside the project');
  const entries = fs.readdirSync(actualCwd, { withFileTypes: true });
  const candidates = entries.filter(e => e.isFile() && /\.(sln|slnx|csproj|fsproj|vbproj)$/.test(e.name)).map(e => path.join(actualCwd, e.name)).sort();
  const solutions = candidates.filter(p => /\.(sln|slnx)$/.test(p));
  if (solutions.length > 1) throw new DotnetCommandError('multiple solutions found; specify one explicitly');
  if (solutions.length === 1) return solutions[0];
  const projects = candidates.filter(p => /\.(csproj|fsproj|vbproj)$/.test(p));
  if (projects.length !== 1) throw new DotnetCommandError(projects.length ? 'multiple projects found; specify one explicitly' : 'no solution or project found');
  return projects[0];
}

export function buildCommand(options) {
  const sdk = String(options.sdk ?? '');
  if (!SDK.has(sdk)) throw new DotnetCommandError('SDK must be 8, 9 or 10');
  let project = options.project || discoverProject(options.projectRoot, options.workingDirectory || '.');
  if (!SAFE_VALUE(project) || !path.isAbsolute(project)) throw new DotnetCommandError('project must be an absolute path inside the mounted source');
  if (options.projectRoot) {
    const root = fs.realpathSync(options.projectRoot);
    if (!within(root, path.resolve(project))) throw new DotnetCommandError('project must be inside the mounted source');
    if (!within(root, fs.realpathSync(project))) throw new DotnetCommandError('project resolves outside the mounted source');
    project = path.posix.join('/src', path.relative(root, path.resolve(project)).split(path.sep).join('/'));
  } else if (!within('/src', path.posix.normalize(project))) throw new DotnetCommandError('container project path must stay inside /src');
  const command = options.operation;
  if (!['build', 'test', 'restore'].includes(command)) throw new DotnetCommandError('operation must be build, test or restore');
  const args = ['dotnet', command, project, '--verbosity', 'minimal'];
  if (options.configuration !== undefined) {
    if (!['Debug', 'Release'].includes(options.configuration)) throw new DotnetCommandError('configuration must be Debug or Release');
    args.push('--configuration', options.configuration);
  }
  if (options.framework !== undefined) {
    if (!SAFE_VALUE(options.framework) || !/^net(?:coreapp|standard)?\d+(?:\.\d+)?$/.test(options.framework)) throw new DotnetCommandError('invalid target framework');
    args.push('--framework', options.framework);
  }
  if (options.noRestore === true && command !== 'restore') args.push('--no-restore');
  if (options.noRestore === true && command === 'restore') throw new DotnetCommandError('--no-restore cannot be used with restore');
  return { sdk, phase: command, command: args, workingDirectory: '/src' };
}
