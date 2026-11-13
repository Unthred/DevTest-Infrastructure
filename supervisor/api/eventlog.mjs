// Issue #1254: the bounded log behind GET /api/v1/events. One JSON file in the state root holds at most 500 events, the id counter and what
// the route last saw (the tick time and the freshness state), so a restart keeps ids growing and two streams never append the same tick.
// Reads and writes are synchronous, so within one dashboard process a pass cannot interleave with another.
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../core.mjs';

export const MAX_EVENTS = 500;
export const INITIAL_ID = 'e-0';
const ID = /^e-(0|[1-9]\d{0,14})$/;
const file = root => path.join(root, 'dashboard', 'events.json');
const idOf = n => `e-${n}`;

// The number inside a valid id, else null (so a malformed Last-Event-ID is "no id").
export function idNumber(id) {
  const match = typeof id === 'string' ? ID.exec(id) : null;
  return match ? Number(match[1]) : null;
}

function load(root) {
  try {
    const log = JSON.parse(fs.readFileSync(file(root), 'utf8'));
    if (Array.isArray(log?.events) && Number.isInteger(log.next)) return log;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return { next: 1, events: [], lastTickAt: null, lastFreshness: null };
}

function appendTo(log, event, now) {
  const { type, ...fields } = event;
  const stored = { id: idOf(log.next), type, at: new Date(now).toISOString(), ...fields };
  log.next += 1;
  log.events.push(stored);
  if (log.events.length > MAX_EVENTS) log.events.splice(0, log.events.length - MAX_EVENTS);
  return stored;
}

// event is { type, ...fields }; the log gives it its id and time. Returns the stored event.
export function append(root, event, now = Date.now()) {
  const log = load(root);
  const stored = appendTo(log, event, now);
  atomicJson(file(root), log);
  return stored;
}

// The id of the newest event, or e-0 for an empty log.
export function newestId(root) {
  const { events } = load(root);
  return events.length ? events[events.length - 1].id : INITIAL_ID;
}

// Every event after id. gap is true when the log no longer holds the event right after id (or id is newer than anything written).
export function readSince(root, id) {
  const log = load(root);
  const from = id === null || id === undefined ? null : idNumber(id);
  if (from === null) return { events: [...log.events], gap: false };
  const first = log.events.length ? idNumber(log.events[0].id) : log.next;
  const gap = from + 1 < first || from >= log.next;
  return { events: gap ? [] : log.events.filter(e => idNumber(e.id) > from), gap };
}

// One pass of the route's watcher. The first call only records what it sees. After that a moved tick time appends one model_changed
// naming models, and a changed freshness state appends one freshness_changed. Returns the events appended.
export function observe(root, { tickAt, freshness, models, now = Date.now() }) {
  const log = load(root);
  const added = [];
  const seenTick = Number.isFinite(tickAt) ? tickAt : null;
  const tickMoved = seenTick !== null && log.lastTickAt != null && seenTick !== log.lastTickAt;
  if (tickMoved) added.push(appendTo(log, { type: 'model_changed', models }, now));
  if (log.lastFreshness && log.lastFreshness !== freshness.state) added.push(appendTo(log, { type: 'freshness_changed', freshness }, now));
  const changed = added.length > 0 || (seenTick !== null && seenTick !== log.lastTickAt) || log.lastFreshness !== freshness.state;
  if (seenTick !== null) log.lastTickAt = seenTick;
  log.lastFreshness = freshness.state;
  if (changed) atomicJson(file(root), log);
  return added;
}
