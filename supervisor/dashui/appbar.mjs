// App bar editing (issue #927, pure logic, no DOM). The bar's items are named; a viewer can rearrange them, remove them and add them
// back. Saved per viewer in browser storage as { v: 1, order: [id], removed: [id] } (convenience only). Items that are not listed
// keep their server order after the listed ones; unknown ids are dropped; a fixed item (the brand, the page title, the sticky and
// theme buttons) is never in the saved lists.
export const BAR_KEY = 'dash.appbar';
export const FIXED = ['brand', 'title', 'sticky', 'theme'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const uniq = (list, ok) => [...new Set((Array.isArray(list) ? list : []).filter(i => typeof i === 'string' && ok(i)))];

// Issue #1221: the status pill item ('agents') and the allowance items ('allowance-<agent>') became one 'agent-<agent>' item per agent.
// A saved layout that lists the old ids keeps its place and its removals instead of going blank: 'allowance-x' becomes 'agent-x'; the
// 'agents' pill becomes every agent item it does not already have, at its place. An agent whose allowance item was removed stays removed;
// when only the pill was removed, all agent items are removed.
const AGENT = 'agent-', OLD_ALLOWANCE = 'allowance-', OLD_PILL = 'agents';
export function migrateSaved(saved, items) {
  if (!isObj(saved) || saved.v !== 1) return saved;
  const order = Array.isArray(saved.order) ? saved.order : [], removed = Array.isArray(saved.removed) ? saved.removed : [];
  if (![...order, ...removed].some(i => i === OLD_PILL || (typeof i === 'string' && i.startsWith(OLD_ALLOWANCE)))) return saved;
  const agentIds = items.filter(i => i.startsWith(AGENT));
  const renamed = i => (typeof i === 'string' && i.startsWith(OLD_ALLOWANCE) ? AGENT + i.slice(OLD_ALLOWANCE.length) : i);
  const allowanceSeen = new Set([...order, ...removed].filter(i => typeof i === 'string' && i.startsWith(OLD_ALLOWANCE)).map(renamed));
  const newOrder = order.flatMap(i => (i === OLD_PILL ? agentIds : [renamed(i)]));
  const newRemoved = removed.flatMap(i => (i === OLD_PILL ? agentIds.filter(a => !allowanceSeen.has(a)) : [renamed(i)]));
  return { ...saved, order: newOrder, removed: newRemoved };
}

// `items` are the ids of the editable items present on this page, in server order.
export function sanitizeBar(rawSaved, items) {
  const saved = migrateSaved(rawSaved, items);
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
