// Issue #1197: item files Foreman has not picked up yet (no status file), shown as state "submitted". Read only; kept apart from
// createInbox() so that factory does not grow. Takes the inbox folder; imports nothing from supervisor/.
import fs from 'node:fs';
import path from 'node:path';

const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const statOf = file => {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
};

export function submittedItems(dir) {
  if (!dir) throw new Error('the inbox is not configured on this server');
  const items = path.join(dir, 'items');
  const status = path.join(dir, 'status');
  let names;
  try {
    names = fs.readdirSync(items);
  } catch {
    throw new Error('the inbox directory is not available');
  }
  const found = [];
  for (const name of names.sort()) {
    const match = /^([a-f0-9]{32})\.json$/.exec(name);
    if (!match || fs.existsSync(path.join(status, name))) continue;
    const file = path.join(items, name);
    const stat = statOf(file);
    const item = stat?.isFile() ? readJson(file) : null;
    if (!item) continue;
    found.push({
      id: match[1],
      shortId: match[1].slice(0, 8),
      kind: item.kind ?? null,
      title: item.title ?? null,
      prompt: item.prompt ?? null,
      state: 'submitted',
      createdAt: stat.mtime.toISOString(),
    });
  }
  return found;
}
