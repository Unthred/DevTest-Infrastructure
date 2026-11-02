// Issue #351: who wrote a pull request head that no Foreman job wrote. The only evidence accepted is a record the model harness wrote
// itself (a Claude Code session log under the host's projects directory): a `git commit`/`git push`/`git rebase` command whose own
// output names this exact head, issued in a turn that records the model. A claim in a commit message, PR text or agent output is not
// evidence. Local file reads only, bounded in files, size and age; no model call.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const GIT_WRITE = /\bgit\b[^\n]*?\b(commit|push|rebase|cherry-pick|am|merge)\b/;
const MAX_FILES = 80, MAX_BYTES = 40 * 1024 * 1024, MAX_AGE_MS = 14 * 86400000;

const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (typeof b === 'string' ? b : b?.text ?? '')).join('\n') : '';
// The abbreviation git prints for a commit: 7+ hex characters that begin the head. Preceded and followed by a non-hex boundary.
function namesHead(output, head) {
  for (const m of output.matchAll(/(?<![0-9a-f])([0-9a-f]{7,40})(?![0-9a-f])/g)) if (head.startsWith(m[1])) return true;
  return false;
}

export function claudeLogFiles(home, now) {
  const root = path.join(home, '.claude', 'projects'), out = [];
  let dirs; try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let names; try { names = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const n of names) {
      if (!/^[\w-]{8,64}\.jsonl$/.test(n)) continue;
      const file = path.join(root, d, n); let st; try { st = fs.lstatSync(file); } catch { continue; }
      if (st.isFile() && st.size <= MAX_BYTES && now - st.mtimeMs <= MAX_AGE_MS) out.push({ file, mtime: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES).map(x => x.file);
}

// Returns { provider: 'claude', models: [raw model ids], sessions: [id prefixes] } when a session log proves a write of this head on
// this branch, else null (no evidence: the writer stays unknown).
export function findHeadWriter({ head, branch, home = process.env.HOME || os.homedir(), now = Date.now(), files = null }) {
  if (!/^[0-9a-f]{40}$/.test(head || '') || !branch) return null;
  const models = new Set(), sessions = new Set();
  for (const file of files || claudeLogFiles(home, now)) {
    let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!raw.includes(head.slice(0, 7))) continue;               // cheap filter before parsing
    const uses = new Map();                                      // tool_use id -> { model, command, branch, session }
    const rows = [];
    for (const line of raw.split('\n')) { if (!line) continue; try { rows.push(JSON.parse(line)); } catch { /* skip a torn line */ } }
    for (const r of rows) if (r.type === 'assistant' && Array.isArray(r.message?.content) && typeof r.message.model === 'string')
      for (const b of r.message.content) if (b?.type === 'tool_use' && b.id && typeof b.input?.command === 'string') uses.set(b.id, { model: r.message.model, command: b.input.command, branch: r.gitBranch, session: r.sessionId });
    for (const r of rows) {
      if (r.type !== 'user' || !Array.isArray(r.message?.content)) continue;
      for (const b of r.message.content) {
        const u = b?.type === 'tool_result' ? uses.get(b.tool_use_id) : null;
        if (!u || !GIT_WRITE.test(u.command) || !(u.branch === branch || u.command.includes(branch)) || !namesHead(textOf(b.content), head)) continue;
        models.add(u.model); if (u.session) sessions.add(String(u.session).slice(0, 8));
      }
    }
  }
  return models.size ? { provider: 'claude', models: [...models].sort(), sessions: [...sessions].sort() } : null;
}
