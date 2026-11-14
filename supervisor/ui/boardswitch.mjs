// Issue #1315: loads the board style modules, keeps the choice in the browser and draws the switch. The decisions are in boardstyles.mjs.
import { STYLE_NAMES, loadedInOrder } from './boardstyles.mjs';
import * as pegStyle from './boardstyle-peg.mjs';
import { el } from './boardlists.mjs';

export const STYLE_KEY = 'devtest.board-style';
const isStyle = module => typeof module?.name === 'string' && typeof module.label === 'string'
  && typeof module.draw === 'function' && typeof module.plan === 'function';

const importStyle = name => import(`./boardstyle-${name}.mjs`);

// Tries each listed style. Peg is the one already imported and is always present; another that fails to load, or has not the shape of a
// style, is left out with one console line. Returns a Map of name to module in list order.
export async function loadStyles(deps = {}) {
  const importer = deps.importStyle ?? importStyle;
  const warn = deps.warn ?? (message => console.warn(message));
  const found = new Map([['peg', pegStyle]]);
  const others = await Promise.all(STYLE_NAMES.filter(name => name !== 'peg').map(async name => {
    try {
      const module = await importer(name);
      if (isStyle(module) && module.name === name) return [name, module];
      warn(`Board style ${name} left out: it is not a style module`);
    } catch {
      warn(`Board style ${name} left out: it did not load`);
    }
    return null;
  }));
  for (const entry of others) if (entry) found.set(...entry);
  return new Map(loadedInOrder([...found.keys()]).map(name => [name, found.get(name)]));
}

// The saved choice; storage that is blocked or throws gives no choice.
export function readChoice(storage) {
  try { return storage?.getItem(STYLE_KEY) ?? null; } catch { return null; }
}

// Returns whether the choice was kept; the switch works for the visit either way.
export function saveChoice(storage, name) {
  try {
    storage.setItem(STYLE_KEY, name);
    return true;
  } catch {
    return false;
  }
}

// A labelled group of buttons with radio semantics. Only the chosen one is in the tab order; the arrow keys move the choice (board.mjs).
export function renderSwitch(styles, current) {
  const group = el('div', { class: 'board-switch', role: 'radiogroup', 'aria-label': 'Board style' });
  for (const [name, style] of styles) {
    const on = name === current;
    const attributes = { type: 'button', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', 'data-style-choice': name };
    group.append(el('button', attributes, style.label));
  }
  return group;
}
