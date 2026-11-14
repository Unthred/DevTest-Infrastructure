// Issue #1312: the live board screen, shown when the page address ends in #/board. It asks for the liveboard model when it opens and
// again each time the change stream says a model changed (app.mjs calls changed()); it draws the model and holds no rules of its own.
// Part 2 (issue #1313): a change event compares the new model with the one before and the balls travel for the events between them
// (boardmotion.mjs, boardtravel.mjs). Opening the screen, Retry and a resize move nothing. No timer fetches data or starts travel.
import { fetchModel } from './client.mjs';
import { drawBoard } from './boardsvg.mjs';
import { renderLists, boxSection, errorLine, detailPanel, el } from './boardlists.mjs';
import { ballDetail, BOXES } from './boardlayout.mjs';
import { dateTime } from './format.mjs';
import { planChange, carryLaps, withLaps } from './boardmotion.mjs';
import { Travels, prefersReducedMotion } from './boardtravel.mjs';

// The ball a key such as running:<job id>, waiting:<place> or landed:<job id> stands for.
export function findBall(data, key) {
  const [kind, id] = String(key).split(/:(.*)/s);
  const pool = { waiting: data.waiting, running: data.running, landed: data.landed }[kind];
  const entry = pool?.find(candidate => String(kind === 'waiting' ? candidate.place : candidate.job_id) === id);
  return entry ? { kind, entry } : null;
}

// The label the board carries for assistive technology; it names the zones the drawing holds, hopper first.
export const BOARD_LABEL = 'Live board: the hopper of waiting work, a lane per agent and model, and the result boxes';

const focusTarget = () => {
  const node = document.activeElement?.closest?.('[data-ball],[data-box]');
  if (!node) return null;
  return [node.hasAttribute('data-ball') ? 'ball' : 'box', node.dataset.ball ?? node.dataset.box, node.closest('.board-lists') !== null];
};

export class BoardScreen {
  constructor(main, deps = {}) {
    this.main = main;
    this.load = deps.fetchModel ?? fetchModel;
    this.width = deps.width ?? (() => main.clientWidth);
    this.model = null;
    this.error = null;
    this.receivedAt = 0;
    this.box = null;
    this.ball = null;
    this.origin = null;
    this.root = null;
    this.running = false;
    this.again = false;
    this.fromChange = false;
    this.travels = deps.travels ?? new Travels();
    this.reduced = deps.reducedMotion ?? prefersReducedMotion;
    this.carry = new Map();
    this.changedCount = 0;
    this.onClick = event => this.activate(event.target);
    this.onKey = event => this.key(event);
    this.onResize = () => this.draw();
  }

  open() {
    if (this.root) return;
    this.root = el('div', { class: 'board-screen' });
    this.main.replaceChildren(this.root);
    this.main.addEventListener('click', this.onClick);
    document.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    this.draw();
    this.refresh();
  }

  close() {
    if (!this.root) return;
    this.main.removeEventListener('click', this.onClick);
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    this.root = null;
    this.ball = null;
    this.box = null;
    this.travels.stop();
  }

  // The one place a travel can start: the change stream said a model changed.
  changed() {
    if (!this.root) return undefined;
    return this.refresh(true);
  }

  // One request at a time; a change that arrives while one runs is run once more after it, so the newest change is never lost.
  async refresh(fromChange = false) {
    this.fromChange ||= fromChange;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    const compare = this.fromChange;
    this.fromChange = false;
    try {
      const before = this.model?.data;
      this.model = await this.load('liveboard');
      this.receivedAt = Date.now();
      this.error = null;
      if (compare && before) this.travelFrom(before, this.model.data);
    } catch (error) {
      this.error = String(error.message ?? error);
    }
    this.running = false;
    this.draw();
    if (this.again) {
      this.again = false;
      await this.refresh();
    }
  }

  // Plans the travels of one change. Nothing travels under reduced motion or below the board width; too many events are shown at once.
  travelFrom(before, after) {
    this.changedCount = 0;
    const plan = planChange(before, after, { width: this.width(), now: Date.now() });
    this.carry = carryLaps(this.carry, plan.events, after);
    this.changedCount = plan.changed;
    if (this.reduced()) return;
    this.travels.begin(plan.travels, after);
  }

  view() {
    return { receivedAt: this.receivedAt, now: Date.now() };
  }

  body() {
    if (!this.model) return this.error ? [] : [el('p', {}, 'Loading the board…')];
    const data = withLaps(this.model.data, this.carry);
    const holder = el('div', { class: 'board-holder', role: 'group', 'aria-label': BOARD_LABEL });
    const svg = drawBoard(data, this.width(), Date.now(), this.view());
    if (svg) holder.append(svg);
    const parts = [holder];
    if (this.box) parts.push(el('div', { class: 'picked-box' }, boxSection(data, this.box, BOXES.find(box => box.id === this.box).label, 'h2')));
    parts.push(renderLists(data, this.view()));
    const found = this.ball ? findBall(data, this.ball) : null;
    if (found) parts.push(detailPanel(ballDetail(found.kind, found.entry, data, { dateTime })));
    else this.ball = null;
    return parts;
  }

  // Redraws in place: the same root, new children; the focused ball or box keeps the focus.
  draw() {
    if (!this.root) return;
    const focused = focusTarget();
    const error = this.error ? errorLine(this.error, this.receivedAt, Boolean(this.model)) : null;
    this.root.className = `board-screen${this.model && this.error ? ' stale' : ''}`;
    const notice = this.changedCount > 0 ? el('p', { class: 'board-changed', role: 'status' }, `${this.changedCount} things changed`) : null;
    this.root.replaceChildren(...[el('h1', {}, 'Live board'), error, notice, ...this.body()].filter(Boolean));
    if (this.model) this.travels.apply(this.root, this.model.data);
    if (!focused) return;
    const [kind, id, inLists] = focused;
    this.root.querySelector(`${inLists ? '.board-lists ' : '.board-svg '}[data-${kind}="${CSS.escape(id)}"]`)?.focus();
  }

  openBall(target) {
    this.origin = target.dataset.ball;
    this.ball = target.dataset.ball;
    this.draw();
    this.root.querySelector('#ball-panel [data-close]')?.focus();
  }

  closeBall() {
    const origin = this.origin;
    this.ball = null;
    this.draw();
    if (origin) this.root.querySelector(`[data-ball="${CSS.escape(origin)}"]`)?.focus();
  }

  activate(target) {
    if (target.closest('[data-retry]')) return this.refresh();
    if (target.closest('[data-close]')) return this.closeBall();
    const ball = target.closest('[data-ball]');
    if (ball) return this.openBall(ball);
    const box = target.closest('[data-box]');
    if (!box) return undefined;
    this.box = this.box === box.dataset.box ? null : box.dataset.box;
    return this.draw();
  }

  key(event) {
    if (event.key === 'Escape' && this.ball) this.closeBall();
    if (event.key !== 'Enter' || !event.target.closest?.('svg [data-ball], svg [data-box]')) return;
    // Without this the Enter that opened the panel would also press the Close button that takes the focus.
    event.preventDefault();
    this.activate(event.target);
  }
}

export const createBoard = (main, deps) => new BoardScreen(main, deps);
