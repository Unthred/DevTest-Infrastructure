// Issue #1115: the GitHub App's ids exist only once the homeowner has created and installed the App, so Foreman cannot know them. The homeowner
// writes them (no secret: two numbers and the path of the key file) as one line "<app_id>:<installation_id>:<absolute key file>" in
// <state root>/team/github-app-offer.txt; Foreman validates the line and raises it as ONE host_value item that the homeowner approves with a click.
import fs from 'node:fs';
import path from 'node:path';
import { validateHostValue } from './hostvalue.mjs';

export const OFFER_FILE = root => path.join(root, 'team', 'github-app-offer.txt');

// Returns the offered value, or null when there is no valid offer or the App is already configured.
export function githubAppOffer(root, configured) {
  if (configured) return null;
  let text;
  try { text = fs.readFileSync(OFFER_FILE(root), 'utf8').trim(); } catch { return null; }
  return validateHostValue('github_app', text) ? text : null;
}

// Raises the offer as one host_value item; true when a new item was raised (the caller then offers nothing else this pass).
export function raiseGithubAppOffer({ inboxStore, dir, root, configured, now, report }) {
  const value = githubAppOffer(root, configured);
  if (!value) return false;
  const why = "Park labels as Foreman's GitHub App; until this is approved every park is refused.";
  if (!inboxStore.raiseHostValue(dir, { key: 'github_app', value, why }, now).raised) return false;
  (report.actions ||= []).push({ type: 'host-value-proposed', result: 'github_app: the App identity offered for approval' });
  return true;
}
