// App bar editing (issue #927, pure logic, no DOM). The bar's items are named; a viewer can rearrange them, remove them and add them
// back. Saved per viewer in browser storage as { v: 1, order: [id], removed: [id] } (convenience only). Items that are not listed
// keep their server order after the listed ones; unknown ids are dropped; a fixed item (the brand, the page title, the sticky and
// theme buttons) is never in the saved lists.
export const BAR_KEY = 'dash.appbar';
export const FIXED = ['brand', 'title', 'sticky', 'theme'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const uniq = (list, ok) => [...new Set((Array.isArray(list) ? list : []).filter(i => typeof i === 'string' && ok(i)))];

// `items` are the ids of the editable items present on this page, in server order.
export function sanitizeBar(saved, items) {
  const known = i => items.includes(i);
  if (!isObj(saved) || saved.v !== 1) return { order: [...items], removed: [] };
  const removed = uniq(saved.removed, known), listed = uniq(saved.order, i => known(i) && !removed.includes(i));
  const order = [...listed, ...items.filter(i => !listed.includes(i) && !removed.includes(i))];
  return { order, removed };
}
export function moveBarItem(state, id, delta) {
  const i = state.order.indexOf(id), j = i + (delta < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= state.order.length) return state;
  const order = [...state.order]; [order[i], order[j]] = [order[j], order[i]];
  return { ...state, order };
}
export const removeBarItem = (state, id) => (state.order.includes(id) ? { order: state.order.filter(i => i !== id), removed: [...state.removed, id] } : state);
export const addBarItem = (state, id) => (state.removed.includes(id) ? { order: [...state.order, id], removed: state.removed.filter(i => i !== id) } : state);
export const barToSaved = state => ({ v: 1, order: state.order, removed: state.removed });
