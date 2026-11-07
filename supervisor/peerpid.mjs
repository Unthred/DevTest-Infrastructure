// Issue #737: who is on the other end of a loopback connection. The dashboard's Resume route must refuse a request from a process that
// descends from a supervised job, not only a dashboard that itself runs under one. For a peer on this host the kernel knows the
// answer: /proc/net/tcp(6) maps the connection (local port = the peer's source port, remote port = the dashboard's port) to a socket
// inode, and /proc/<pid>/fd/* links name the processes that hold that inode. Read-only; no command is run.
import fs from 'node:fs';

const defaultRead = p => fs.readFileSync(p, 'utf8');
const defaultList = p => fs.readdirSync(p);
const defaultLink = p => fs.readlinkSync(p);

// Is the peer on this machine? True for a loopback peer, or one whose address equals the address it connected to.
export function isLocalPeer(socket) {
  const a = String(socket?.remoteAddress || '').replace(/^::ffff:/, ''), b = String(socket?.localAddress || '').replace(/^::ffff:/, '');
  return !!a && (a === '::1' || a.startsWith('127.') || a === b);
}

// The socket inode of the connection whose source port is `peerPort` and destination port is `serverPort`, or null.
export function inodeOf(peerPort, serverPort, { read = defaultRead } = {}) {
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = read(file); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      const lp = parseInt(f[1].split(':')[1], 16), rp = parseInt(f[2].split(':')[1], 16);
      if (lp === peerPort && rp === serverPort && f[9] !== '0') return f[9];
    }
  }
  return null;
}

// A process that holds the socket inode. Several can (a forked child); any one of them is the caller's own tree, so the first is enough
// for an ancestry check. Returns a pid number, or null when it cannot be told (for example, no permission to read other processes' fds).
export function pidOfInode(inode, { list = defaultList, link = defaultLink } = {}) {
  let pids;
  try { pids = list('/proc').filter(n => /^\d+$/.test(n)); } catch { return null; }
  for (const pid of pids) {
    let fds;
    try { fds = list(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try { if (link(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return Number(pid); } catch { /* fd closed meanwhile */ }
    }
  }
  return null;
}

export function peerPid(socket, io = {}) {
  const inode = inodeOf(socket?.remotePort, socket?.localPort, io);
  return inode ? pidOfInode(inode, io) : null;
}
