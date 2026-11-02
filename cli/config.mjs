// Runner configuration for the dev-test CLI. The file holds policy (allowlisted projects, storage root, limits), never secrets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CONFIG = '/mnt/cache/appdata/devtest-infrastructure/state/runner.json';

export class EnvironmentError extends Error { constructor(message) { super(message); this.name = 'EnvironmentError'; } }

// DEV_TEST_CONFIG overrides the default path. The lock file defaults to this repository's docker/images.lock.json.
export function loadConfig(env = process.env) {
  const file = env.DEV_TEST_CONFIG || DEFAULT_CONFIG;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { throw new EnvironmentError(`runner configuration not found at ${file}; copy docker/runner.example.json there (or set DEV_TEST_CONFIG) and edit it`); }
  let config;
  try { config = JSON.parse(text); } catch { throw new EnvironmentError(`runner configuration ${file} is not valid JSON`); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new EnvironmentError(`runner configuration ${file} must be a JSON object`);
  for (const key of ['allowedProjects', 'storageRoot', 'uid', 'gid', 'limits'])
    if (config[key] === undefined) throw new EnvironmentError(`runner configuration ${file} is missing "${key}"`);
  const lockFile = config.lockFile ? path.resolve(path.dirname(file), config.lockFile) : path.join(REPO_ROOT, 'docker', 'images.lock.json');
  try { config.lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); }
  catch { throw new EnvironmentError(`image lock file ${lockFile} is missing or not valid JSON`); }
  return { config, file };
}
