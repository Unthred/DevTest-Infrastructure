// Issue #1466: how a job record of the Inbox Running view is drawn. The Table and Compact list call factsHtml and jobTitleHtml from
// inbox-views.mjs; the Cards view and the "jobs running now" line are here. Pure string building.
import { ageText, kindLabel, stateMark, stateSeverity } from './dashui/inbox-views.mjs';

const part = (text, esc) => (text ? esc(text) : '');

// The one secondary line: agent, model, role, job kind, attempt and elapsed time, then Watch live when the job has a transcript.
export function factsHtml(job, esc) {
  const attempt = job.attempt ? `attempt ${job.attempt}` : '';
  const elapsed = job.elapsed ? `elapsed ${job.elapsed}` : '';
  const words = [job.agent, job.model, job.role, job.kind, attempt, elapsed].filter(Boolean);
  const watch = job.hasTranscript ? ` · <a class="iv-watch" href="${esc(job.href)}">Watch live</a>` : '';
  return `<span class="iv-jobfacts">${words.map(w => part(w, esc)).join(' · ')}${watch}</span>`;
}

export const jobTitleLink = (job, inner, esc) => `<a class="iv-joblink" href="${esc(job.href)}">${inner}</a>`;

const chip = (sev, mark, word, esc) => `<span class="badge sev-${sev}"><span aria-hidden="true">${mark}</span> ${esc(word)}</span>`;

export function jobCard(rec, now, { esc, highlight }) {
  const [mark, word] = stateMark(rec.state);
  const job = { ...rec.job, elapsed: Number.isFinite(rec.createdAt) && Number.isFinite(now) ? ageText(rec.createdAt, now) : '' };
  const reference = rec.reference ? `<span class="inbox-ref">${highlight(rec.reference)}</span> ` : '';
  const source = rec.pr ? `PR #${rec.pr}` : rec.issue ? `Issue #${rec.issue}` : '';
  return `<li class="inbox-item inbox-job" data-job="${esc(rec.id)}"><h3 class="inbox-title t">${reference}${jobTitleLink(job, highlight(rec.title), esc)}</h3>`
    + `<div class="sub">${chip('info', '▪', kindLabel('job'), esc)} ${chip(stateSeverity(rec.state), mark, word, esc)}${source ? ` ${esc(source)}` : ''}</div>`
    + `<div class="sub">${factsHtml(job, esc)}</div></li>`;
}


export function runningLine(count, esc) {
  const text = `${count} job${count === 1 ? '' : 's'} running now`;
  return `<p class="inbox-running-line" data-running-now="${count}"><a href="/inbox?state=running">${esc(text)}</a></p>`;
}
