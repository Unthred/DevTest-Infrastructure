// Issue #1414: the number of an Inbox card is reserved when foreman_propose writes the item, so the reply can name it. The MCP account may
// write only <inbox>/items/, so a reservation is a marker file there, named .n<number> and holding the item id; creating it with the
// exclusive flag means two proposals arriving together can never take the same number. Foreman adopts the reserved number when it picks the
// item up (supervisor/inboxnumber.mjs), keeps the counter in status/number.json, and deletes the marker. A marker is not an item: the
// pickup scan only reads <32 hex>.json names. Imports nothing from supervisor/.
import fs from 'node:fs';
import path from 'node:path';

const MARKER = /^\.n(\d{1,9})$/;
const ID = /^[a-f0-9]{32}$/;
const COUNTER_FILE = 'number.json';
const MAX_TRIES = 200;
const validNumber = value => Number.isSafeInteger(value) && value > 0;
const readText = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const namesIn = dir => { try { return fs.readdirSync(dir); } catch { return []; } };

export const markerName = number => `.n${number}`;

// Every reservation still on disk: [{ number, id }] (id is '' while the marker is still being written).
export function reservations(inboxDir) {
  const items = path.join(inboxDir, 'items');
  return namesIn(items).map(name => [MARKER.exec(name), name]).filter(([match]) => match)
    .map(([match, name]) => ({ number: Number(match[1]), id: readText(path.join(items, name)) }));
}

export const reservedNumber = (inboxDir, id) => reservations(inboxDir).find(r => r.id === id)?.number ?? null;

// The highest number Foreman's counter, a status file or a reservation shows. A damaged counter simply counts for nothing, so the
// next number is still one above the highest in use and never restarts at one.
export function highestNumber(inboxDir) {
  const status = path.join(inboxDir, 'status');
  const counter = readJson(path.join(status, COUNTER_FILE))?.last;
  const stored = namesIn(status).filter(name => ID.test(name.slice(0, 32)) && name.endsWith('.json')).map(name => readJson(path.join(status, name))?.number);
  return Math.max(0, ...[counter, ...stored, ...reservations(inboxDir).map(r => r.number)].filter(validNumber));
}

// Takes the next free number for `id`. The exclusive create is the atomic step; a taken name moves on to the next number.
export function reserveNumber(inboxDir, id) {
  const items = path.join(inboxDir, 'items');
  const first = highestNumber(inboxDir) + 1;
  for (let number = first; number < first + MAX_TRIES; number++) {
    try {
      fs.writeFileSync(path.join(items, markerName(number)), id, { flag: 'wx', mode: 0o600 });
      return number;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('no inbox number could be reserved; try again');
}

export const releaseReservation = (inboxDir, number) => { try { fs.unlinkSync(path.join(inboxDir, 'items', markerName(number))); } catch { /* already gone */ } };

// The item id that holds a number: a status file first, then a reservation Foreman has not adopted yet.
export function idOfNumber(inboxDir, number) {
  const status = path.join(inboxDir, 'status');
  for (const name of namesIn(status)) {
    if (ID.test(name.slice(0, 32)) && name.endsWith('.json') && readJson(path.join(status, name))?.number === number) return name.slice(0, 32);
  }
  const held = reservations(inboxDir).find(r => r.number === number && ID.test(r.id));
  return held ? held.id : null;
}
