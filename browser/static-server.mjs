#!/usr/bin/env node
// Host-side static file server on a Unix socket. It is the "declared target" a browser run may reach: GET/HEAD only,
// files below one root, no directory listing, no symlink following, no network listener.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };

export function createStaticServer(root) {
  const base = fs.realpathSync(root);
  return http.createServer((req, res) => {
    const deny = (code) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(`${code}\n`); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405);
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return deny(400); }
    if (pathname.includes('\0')) return deny(400);
    const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const file = path.join(base, relative);
    if (file !== base && !file.startsWith(base + path.sep)) return deny(403);
    let st, real; try { st = fs.lstatSync(file); real = fs.realpathSync(file); } catch { return deny(404); }
    // base is a real path, so a symlinked component anywhere (not just the last) makes the resolved path differ from the joined one.
    if (real !== file) return deny(403);
    if (!st.isFile()) return deny(st.isSymbolicLink() ? 403 : 404);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// Creates the private socket directory, listens, and hands the socket to the container user. Returns { server, close }.
export function listenOnSocket(server, socketPath, { uid, gid }) {
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.rmSync(socketPath, { force: true });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      fs.chownSync(socketPath, uid, gid); fs.chmodSync(socketPath, 0o600);
      resolve({ server, close: () => new Promise((done) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); done(); })) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [root, socket, uid = '99', gid = '100'] = process.argv.slice(2);
  if (!root || !socket) { process.stderr.write('usage: static-server.mjs ROOT SOCKET [UID GID]\n'); process.exit(2); }
  const handle = await listenOnSocket(createStaticServer(root), socket, { uid: Number(uid), gid: Number(gid) });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => handle.close().then(() => process.exit(0)));
}
