// "Accept split": file each proposed child once (a marker makes a repeat safe), queue it for the same agent, say so on the parent.
// Moved out of the Team class unchanged (issue #1240); the stuck-PR split approval calls it too.
import { SupervisorError } from './core.mjs';
import { splitChildBody, splitAcceptedText } from './splitstuck-draft.mjs';

export async function acceptSplit(team, issue) {
  const sp = team.s.splits[issue];
  if (!sp || sp.status !== 'proposed') throw new SupervisorError(`issue #${issue} has no proposed split to accept${sp ? ` (state: ${sp.status})` : ''}`);
  const q = team.s.unblock.queued[sp.agent] ||= [];
  for (const [i, c] of sp.children.entries()) {
    if (c.issue) continue;
    const marker = `<!-- devtest-split-child v1 parent=${issue} idx=${i} -->`;
    c.issue = await team.gh.findIssueByMarker(marker) || await team.gh.createIssue(c.title, splitChildBody(marker, c, sp, i, issue));
    if (!q.includes(c.issue)) q.push(c.issue);
    team.save();
  }
  sp.status = 'accepted';
  sp.acceptedAt = team.clock.now();
  team.save();
  await team.postNotice(issue, 'split-accepted', splitAcceptedText(sp));
  return sp.children.map(c => c.issue);
}
