// Shared by the Tower smoke gates. The container runs as uid 99 and mounts the project read-only at /src, so a project directory
// the container user cannot read (a 0700 clone, as mktemp -d and most review clones are) makes every run fail as exit 2. When the
// project is not readable, stage the files the browser track needs into a 0755 copy under /mnt/user/projects and use that; the
// original is never chmod-ed. Returns { project, cleanup }.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { containerCanRead } from '../docker/runner.mjs';

export function stageProject(project, uid, gid) {
  if (containerCanRead(project, uid, gid)) return { project, staged: false, cleanup: () => {} };
  const dir = path.join('/mnt/user/projects', `.devtest-stage-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(path.join(dir, 'docker'), { recursive: true, mode: 0o755 });
  fs.cpSync(path.join(project, 'browser'), path.join(dir, 'browser'), { recursive: true });
  fs.copyFileSync(path.join(project, 'docker', 'images.lock.json'), path.join(dir, 'docker', 'images.lock.json'));
  const open = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) { fs.chmodSync(f, 0o755); open(f); } else if (e.isFile()) fs.chmodSync(f, 0o644); } };
  fs.chmodSync(dir, 0o755); fs.chmodSync(path.join(dir, 'docker'), 0o755); open(dir);
  return { project: fs.realpathSync(dir), staged: true, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
