// Issue #1238: holds that wait for each other. Pure: no I/O, no clock.
// A hold is { id, waiter, waitsFor, priority, text }: `waiter` cannot proceed until `waitsFor` has. Two holds that wait for each other
// (A waits for B and B waits for A) freeze both for ever, so the lowest priority hold of each cycle is dropped.

// One cycle as the list of holds along it, or null. Depth first over the holds; the first back edge closes a cycle.
export function findCycle(holds) {
  const out = new Map();
  for (const h of holds) { if (!out.has(h.waiter)) out.set(h.waiter, []); out.get(h.waiter).push(h); }
  const done = new Set();
  const visit = (node, path, onPath) => {
    if (onPath.has(node)) { const at = path.findIndex(h => h.waiter === node); return path.slice(at); }
    if (done.has(node)) return null;
    onPath.add(node);
    for (const h of out.get(node) || []) {
      const found = visit(h.waitsFor, [...path, h], onPath);
      if (found) return found;
    }
    onPath.delete(node); done.add(node);
    return null;
  };
  for (const node of out.keys()) { const found = visit(node, [], new Set()); if (found) return found; }
  return null;
}

// The lowest priority hold of a cycle; equal priorities fall to the id order so the choice is repeatable.
export const weakest = cycle => [...cycle].sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)))[0];

// Break every cycle: returns { dropped, cycles } where cycles lists the holds of each cycle found, before the drop.
export function breakCycles(holds) {
  let rest = [...holds];
  const dropped = [], cycles = [];
  for (let guard = 0; guard < holds.length + 1; guard++) {
    const cycle = findCycle(rest);
    if (!cycle) break;
    const drop = weakest(cycle);
    cycles.push(cycle); dropped.push(drop);
    rest = rest.filter(h => h.id !== drop.id);
  }
  return { dropped, cycles };
}
