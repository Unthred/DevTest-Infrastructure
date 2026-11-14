// "Accept split": file each proposed child once (a marker makes a repeat safe), queue it for the same agent, say so on the parent.
// Moved out of the Team class (issue #1338). The two ordinary texts are unchanged; they are now built by the two small functions below, and
// a child that carries its own body (a split of a stuck pull request) uses that body instead of the short text.
import { SupervisorError } from './core.mjs';
import { withPrerequisite } from './splitstuck-draft.mjs';

function childBody(marker, child, split, index, parent) {
  if (!child.body) {
    const head = `Part ${index + 1} of ${split.children.length} of #${parent}, split by Foreman after #${parent} ran out of context (accepted by the homeowner).`;
    return `${marker}\n${head}\n\n**Scope:** ${child.scope}\n\nRead #${parent} for the full requirements; deliver only this part.`;
  }
  const earlier = child.after == null ? null : split.children[child.after]?.issue;
  if (child.after != null && !earlier) throw new SupervisorError('the item it waits for has no issue number yet');
  return `${marker}\n${earlier ? withPrerequisite(child.body, earlier) : child.body}`;
}

function acceptedText(split) {
  const filed = split.children.map(c => `#${c.issue}`).join(', ');
  const rest = split.stuckPr
    ? 'The PR stays parked, with its branch kept, until the close as superseded item lands and closes it.'
    : 'This issue is not started again; close it when the children are done.';
  return `**Split accepted.** Filed ${filed} and queued them for \`${split.agent}\`. ${rest}`;
}

export async function acceptSplit(team, issue) {
  const sp = team.s.splits[issue];
  if (!sp || sp.status !== 'proposed') throw new SupervisorError(`issue #${issue} has no proposed split to accept${sp ? ` (state: ${sp.status})` : ''}`);
  const q = team.s.unblock.queued[sp.agent] ||= [];
  for (const [i, c] of sp.children.entries()) {
    if (c.issue) continue;
    const marker = `<!-- devtest-split-child v1 parent=${issue} idx=${i} -->`;
    c.issue = await team.gh.findIssueByMarker(marker) || await team.gh.createIssue(c.title, childBody(marker, c, sp, i, issue));
    if (!q.includes(c.issue)) q.push(c.issue);
    team.save();
  }
  sp.status = 'accepted';
  sp.acceptedAt = team.clock.now();
  team.save();
  await team.postNotice(issue, 'split-accepted', acceptedText(sp));
  return sp.children.map(c => c.issue);
}
