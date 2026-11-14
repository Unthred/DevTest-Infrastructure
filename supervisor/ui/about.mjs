// Issue #1449: the About box. It draws the about model (GET /api/v1/about) into a native dialog with textContent only, so no text from the
// model is ever read as markup. Nothing is fetched until the box is opened; it holds no state beyond the open dialog.
import { fetchModel as defaultFetch } from './client.mjs';
import { clock, dateTime } from './format.mjs';

const GROUPS = [['fixed', 'Fixed'], ['improved', 'Improved'], ['screens', 'Screens'], ['tidying', 'Tidying']];
const MATCH = { true: 'runs the installed version', false: 'does not run the installed version', null: 'version match not known' };
const DAY_MS = 86400000;
const ZONE = 'Europe/London';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = ms => dayFormat.format(ms);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) if (value !== null && value !== undefined) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

// "installed today at 09:18", "installed yesterday at 22:05", "installed Fri 13 Nov, 22:05".
export function installedWords(iso, now) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'Install time not recorded';
  const key = dayKey(at);
  if (key === dayKey(now)) return `Installed today at ${clock(iso)}`;
  if (key === dayKey(now - DAY_MS)) return `Installed yesterday at ${clock(iso)}`;
  return `Installed ${dateTime(iso)}`;
}

// One line: paused with the reason, or how many changes wait, or up to date.
export function statusLine(data) {
  if (data.hold) return `Upgrades are paused: ${data.hold.reason}`;
  if (data.behind > 0) return `${plural(data.behind, 'change')} waiting to install`;
  if (data.behind === 0) return 'Up to date';
  return 'Whether changes are waiting is not known';
}

// The earlier installs grouped by calendar day, newest day first; each day holds the changes of all its installs.
export function earlierDays(installs, now) {
  const days = new Map();
  for (const install of installs.filter(entry => !entry.current)) {
    const key = dayKey(Date.parse(install.at));
    days.set(key, [...(days.get(key) ?? []), ...install.changes]);
  }
  const label = key => (key === dayKey(now) ? 'Today' : key === dayKey(now - DAY_MS) ? 'Yesterday' : dateTime(`${key}T12:00:00Z`).split(',')[0]);
  return [...days].sort((a, b) => b[0].localeCompare(a[0])).map(([key, changes]) => ({ label: label(key), changes }));
}

function groupedChanges(changes) {
  const parts = [];
  for (const [group, heading] of GROUPS) {
    const own = changes.filter(change => change.group === group);
    if (!own.length) continue;
    parts.push(el('h4', {}, heading), el('ul', { class: 'about-changes' }, ...own.map(change => el('li', {}, change.text))));
  }
  return parts;
}

const part = (title, open, ...body) => {
  const node = el('details', { class: 'about-part' }, el('summary', {}, title), ...body);
  node.open = open;
  return node;
};

function newPart(data) {
  const current = data.installs.find(install => install.current);
  const body = current?.changes.length ? groupedChanges(current.changes) : [el('p', {}, 'Nothing new is recorded yet.')];
  return part('What is new in this version', true, ...body);
}

function earlierPart(data, now) {
  const days = earlierDays(data.installs, now);
  const body = days.length
    ? days.map(day => part(`${day.label} (${plural(day.changes.length, 'change')})`, false, ...groupedChanges(day.changes)))
    : [el('p', {}, 'Nothing earlier is recorded.')];
  return part('Earlier', false, ...body);
}

const row = (label, value) => el('li', {}, el('b', {}, `${label}: `), value);

function technicalPart(data) {
  const current = data.installs.find(install => install.current);
  const processes = data.processes.map(p => {
    const state = MATCH[String(p.matches_installed)];
    return el('li', {}, `${p.role} (process ${p.pid}, ${p.version.slice(0, 7)}): ${state}`);
  });
  const numbers = (current?.changes ?? []).map(change => el('li', {}, `Pull request ${change.pr}${change.issue ? `, issue ${change.issue}` : ''}`));
  return part('Technical details', false,
    el('ul', { class: 'about-tech' },
      row('Installed commit', data.installed.commit ?? 'unknown'),
      row('Commit of main', data.main?.commit ?? 'unknown'),
      row('MCP server version', data.mcp_version ?? 'unknown')),
    el('h4', {}, 'Processes'), processes.length ? el('ul', {}, ...processes) : el('p', {}, 'No process is recorded.'),
    el('h4', {}, 'Changes of this install'), numbers.length ? el('ul', {}, ...numbers) : el('p', {}, 'None.'));
}

export function renderAbout(content, data, now) {
  content.replaceChildren(
    el('h2', { id: 'about-title' }, 'Foreman'),
    el('p', { class: 'about-version' }, el('b', {}, data.installed.short ?? 'unknown version')),
    el('p', {}, data.installed.installed_at ? installedWords(data.installed.installed_at, now) : 'Install time not recorded'),
    el('p', { class: 'about-status' }, statusLine(data)),
    newPart(data), earlierPart(data, now), technicalPart(data),
  );
}

function renderFailure(content, retry) {
  const again = el('button', { type: 'button', class: 'chip', 'data-about-retry': '' }, 'Try again');
  again.addEventListener('click', retry);
  const line = el('p', { class: 'about-failed' }, 'The version and what is new could not be loaded.');
  content.replaceChildren(el('h2', { id: 'about-title' }, 'Foreman'), line, again);
}

// The button for the end of the app bar, and the box it opens. deps are for tests.
export function createAbout(deps = {}) {
  const fetchModel = deps.fetchModel ?? defaultFetch;
  const now = deps.now ?? Date.now;
  const dialog = el('dialog', { class: 'about', 'aria-labelledby': 'about-title' });
  const content = el('div', { class: 'about-content' });
  const close = el('button', { type: 'button', class: 'chip about-close' }, 'Close');
  dialog.append(el('div', { class: 'about-head' }, close), content);
  document.body.append(dialog);
  const returnFocus = () => document.querySelector('[data-about]')?.focus();
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', returnFocus);

  async function load() {
    content.replaceChildren(el('p', {}, 'Loading'));
    try {
      renderAbout(content, (await fetchModel('about')).data, now());
    } catch {
      renderFailure(content, load);
    }
  }
  function open() {
    if (!dialog.open) dialog.showModal();
    return load();
  }
  const button = () => {
    const node = el('button', { type: 'button', class: 'chip about-button', 'data-about': '' }, 'About');
    node.addEventListener('click', open);
    return node;
  };
  return { button, open };
}
