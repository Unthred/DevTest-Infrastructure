// Issue #1315: the pure side of the live board styles. The ordered list of style names and the rules that pick one. No DOM, no storage:
// boardswitch.mjs loads the style modules and keeps the choice, this module only decides.

// The order of the switch. A name here is tried when the screen opens; a style that does not load is left out. Peg is always present.
export const STYLE_NAMES = Object.freeze(['peg', 'marble', 'launch']);
export const DEFAULT_STYLE = 'peg';

// The saved name when that style loaded, otherwise peg.
export function chooseStyle(saved, loaded) {
  return typeof saved === 'string' && loaded.includes(saved) ? saved : DEFAULT_STYLE;
}

// The loaded names in the order of the list; a name that is not in the list is never shown.
export const loadedInOrder = loaded => STYLE_NAMES.filter(name => loaded.includes(name));

// The switch is shown only when there is something to choose between.
export const showSwitch = loaded => loadedInOrder(loaded).length > 1;

// The style an arrow key moves to from the current one, wrapping round; null for any other key.
export function stepStyle(loaded, current, key) {
  const names = loadedInOrder(loaded);
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[key];
  if (step === undefined || names.length === 0) return null;
  const at = names.indexOf(current);
  return names[(Math.max(at, 0) + step + names.length) % names.length];
}
