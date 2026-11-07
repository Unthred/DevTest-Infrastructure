// Issue #946: the Foreman MCP server copy installed beside Foreman. tools/install-foreman-mcp.sh keeps <INSTALL_DIR>/foreman-mcp and
// <INSTALL_DIR>/VERSION in step with the installed commit; INSTALL_DIR is named in <state>/foreman-mcp.install. These readers only read.
import fs from 'node:fs';
import path from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
// Paths the MCP server is built from. A change to any of them needs an install (see mcpNeedsInstall and the plan test).
export const MCP_PATHS = ['foreman-mcp/'];
export const mcpNeedsInstall = files => (files || []).some(f => typeof f === 'string' && MCP_PATHS.some(p => f.startsWith(p)));

// VERSION_FILE=relative/path in the same file moves the version file (default VERSION); its first line is the commit.
export function mcpVersionFile(root) {
  const dir = mcpInstallDir(root); if (!dir) return null;
  let rel = 'VERSION';
  try { const m = /^VERSION_FILE=([A-Za-z0-9._/-]+)$/m.exec(fs.readFileSync(path.join(root, 'foreman-mcp.install'), 'utf8')); if (m && !m[1].startsWith('/') && !m[1].includes('..')) rel = m[1]; } catch { /* default */ }
  return path.join(dir, rel);
}
export function mcpInstallDir(root) {
  try {
    const m = /^INSTALL_DIR=(\/[^\n]*)$/m.exec(fs.readFileSync(path.join(root, 'foreman-mcp.install'), 'utf8'));
    return m && !m[1].includes('..') ? m[1].trim() : null;
  } catch { return null; }
}
// { configured, installed (sha or null), drift (installed differs from foreman) , last (result of the latest install attempt) } or null when not configured.
export function readMcpInstall(root, foremanSha = null) {
  const dir = mcpInstallDir(root);
  if (!dir) return null;
  let installed = null; try { const v = fs.readFileSync(mcpVersionFile(root), 'utf8').split('\n')[0].trim(); installed = SHA.test(v) ? v : null; } catch { /* not installed */ }
  let last = null;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(root, 'team', 'mcp-install.json'), 'utf8'));
    last = { sha: SHA.test(r.sha || '') ? r.sha : null, result: String(r.result || '').slice(0, 16), reason: String(r.reason || '').slice(0, 200), at: Number.isFinite(r.at) ? r.at : null };
  } catch { /* none */ }
  return { installed, drift: !!foremanSha && installed !== foremanSha, last };
}
