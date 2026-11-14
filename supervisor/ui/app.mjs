// Issue #1266: the shell. It wires the client to the app bar: first fetch, live refetch on a change, the theme, and the panel of one agent.
// A screen module is added by importing it here and giving it the element #main; the board (#/board) is the first.
import { fetchModel, openStream } from './client.mjs';
import { renderBar, renderPanel, renderBanners } from './appbar.mjs';
import { createBoard } from './board.mjs';
import { createAbout } from './about.mjs';

const THEME_KEY = 'foreman-ui-theme';
const REDRAW_MS = 30000;
const bar = document.getElementById('appbar');
const panel = document.getElementById('panel');
const banners = document.getElementById('banners');

const main = document.getElementById('main');
const board = createBoard(main);
const BOARD_HASH = '#/board';
const about = createAbout();

const state = { model: null, groups: new Map(), connection: 'connecting', theme: 'light', open: null, receivedAt: Date.now(), freshness: null };

function readTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage blocked: the system setting applies */ }
  if (saved === 'light' || saved === 'dark') return saved;
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(theme, remember) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  if (!remember) return;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* the choice just is not kept */ }
}

const view = () => ({ ...state, now: Date.now() });
const openAgent = () => state.model?.data.agents.find(agent => agent.id === state.open) ?? null;

function positionPanel(chip) {
  const rect = chip.getBoundingClientRect();
  const width = panel.offsetWidth;
  const left = Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 8));
  panel.style.left = `${left}px`;
  panel.style.top = `${bar.getBoundingClientRect().bottom + 4}px`;
}

function draw() {
  const focused = document.activeElement?.closest?.('[data-agent]')?.dataset.agent;
  const aboutFocused = document.activeElement?.closest?.('[data-about]');
  const current = view();
  renderBar(bar, current);
  bar.append(about.button());
  if (aboutFocused) bar.querySelector('[data-about]')?.focus();
  renderBanners(banners, current);
  const agent = openAgent();
  panel.hidden = !agent;
  if (!agent) return;
  renderPanel(panel, agent, current);
  const chip = bar.querySelector(`[data-agent="${agent.id}"]`);
  if (chip) positionPanel(chip);
  if (focused === agent.id) chip?.focus();
}

function closePanel(returnFocus) {
  const id = state.open;
  state.open = null;
  draw();
  if (returnFocus && id) bar.querySelector(`[data-agent="${id}"]`)?.focus();
}

bar.addEventListener('click', event => {
  const chip = event.target.closest('[data-agent]');
  const theme = event.target.closest('[data-theme-switch]');
  if (theme) {
    applyTheme(theme.dataset.themeSwitch, true);
    draw();
    return;
  }
  if (!chip) return;
  state.open = state.open === chip.dataset.agent ? null : chip.dataset.agent;
  draw();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.open) closePanel(true);
});
document.addEventListener('click', event => {
  if (state.open && !event.target.closest('[data-agent], #panel')) closePanel(false);
});

// One fetch at a time; a request made while one runs is run once more after it, so the newest change is never lost.
let running = false;
let again = false;
async function refresh() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    state.model = await fetchModel('appbar');
    state.receivedAt = Date.now();
    state.freshness = state.model.freshness;
  } catch { /* the last model stays on screen; the next change or reconnect tries again */ }
  running = false;
  draw();
  if (again) {
    again = false;
    await refresh();
  }
}

async function loadGroups() {
  try {
    const meta = await fetchModel('meta');
    state.groups = new Map(meta.data.states.map(entry => [entry.state, entry.group]));
  } catch { /* every state then reads as unknown until the next load */ }
}

// With no board address the main area holds one link to it. The app bar is the same on both.
function route() {
  if (location.href.endsWith(BOARD_HASH)) {
    board.open();
    return;
  }
  board.close();
  const link = document.createElement('a');
  link.href = BOARD_HASH;
  link.textContent = 'Open the live board';
  const paragraph = document.createElement('p');
  paragraph.className = 'screen-link';
  paragraph.append(link);
  main.replaceChildren(paragraph);
}
window.addEventListener('hashchange', route);

applyTheme(readTheme(), false);
draw();
route();
await loadGroups();
await refresh();
openStream({
  onState: next => {
    const was = state.connection;
    state.connection = next;
    draw();
    if (next === 'live' && (was === 'reconnecting' || was === 'behind')) {
      refresh();
      board.changed();
    }
  },
  onChange: names => {
    if (names === null || names.includes('appbar')) refresh();
    if (names === null || names.includes('liveboard')) board.changed();
  },
  onFreshness: freshness => {
    const changed = freshness.state !== state.freshness?.state;
    state.freshness = freshness;
    if (changed) draw();
  },
});
setInterval(draw, REDRAW_MS);
