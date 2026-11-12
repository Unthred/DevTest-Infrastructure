// Jobs view side panel (issue #1220): everything about one job, as HTML. The decisions are in dashui/jobs-table.mjs; the helpers that draw
// links, times and copy buttons are passed in by the page (jobs-page.mjs) so this file imports nothing from the renderer.
import { decisionHtml } from './decisioncard-ui.mjs';
import { fmtCost, fmtCount, fmtDuration, jobsQuery, refText, sameRef } from './dashui/jobs-table.mjs';

const JOB_CARD_ID = /^(?:job|selfcheck-job)-([a-f0-9]{8})/;
const MET = { true: 'Met', false: 'Not met' };

const row = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;

// The Needs you cards that name this job: their controls (resume, stop, close) are the shared decision card controls, posted to /decision.
function actions(job, view, h) {
  const items = (view.panels?.needsYou || []).filter(a => JOB_CARD_ID.exec(String(a.id))?.[1] === job.id && a.card);
  if (!items.length) return '<p class="sub" data-job-actions>No action applies to this job now: it is not waiting on a decision.</p>';
  return `<div data-job-actions>${items.map(a => `<div class="job-action">${decisionHtml(a, `job-act-${h.esc(a.id)}`)}</div>`).join('')}</div>`;
}

function postcondition(j, h) {
  const pc = j.postcondition || {};
  const state = pc.kind == null ? 'none recorded' : `${pc.kind}: ${MET[pc.met] || 'not yet decided'}`;
  return `<p data-job-postcondition>${h.esc(state)}</p>${pc.because ? `<p class="sub">${h.esc(pc.because)}</p>` : ''}`;
}

function others(job, rows, f, h) {
  const list = sameRef(rows, job);
  if (list.length < 2) return '<p class="sub">No other job is recorded for this item.</p>';
  const items = list.map(r => `<li${r.id === job.id ? ' aria-current="true"' : ''} data-same-ref="${h.esc(r.id)}"><a href="${h.esc(`/work?${jobsQuery(f, { job: r.id })}`)}"><span class="mono">${h.esc(r.id)}</span> ${h.esc(r.kind)}</a> ${h.esc(r.status)} · ${h.lt(r.startedAt)}</li>`);
  return `<ol class="jobs-same-ref">${items.join('')}</ol>`;
}

export function jobPanel({ job, source, rows, view, filters, h }) {
  const refLink = job.ref == null ? '–' : job.refKind === 'issue' ? h.issueLink(job.ref) : h.prLink(job.ref);
  const record = `<dl class="kv" data-job-record>${row('Job', `<span class="mono">${h.esc(job.fullId)}</span> ${h.copyBtn(job.fullId, 'job ID')}`)}`
    + row('Agent', h.agentTag(job.agent, view)) + row('Kind', h.esc(job.kind)) + row('Model', h.esc(job.model || 'default')) + row('Effort', h.esc(job.effort || 'default'))
    + row('Work', `${h.esc(refText(job) || '–')} ${job.ref == null ? '' : refLink}`) + row('Branch', h.esc(source.branch || '–')) + row('Status', h.esc(job.status))
    + row('Attempts', h.esc(fmtCount(job.attempts))) + row('Started', h.lt(job.startedAt)) + row('Duration', h.esc(fmtDuration(job.durationMs)))
    + row('Tokens in', h.esc(fmtCount(job.tokensIn))) + row('Tokens out', h.esc(fmtCount(job.tokensOut))) + row('Cost', h.esc(fmtCost(job.costGbp)))
    + row('Wasted tokens', h.esc(fmtCount(job.wasted))) + row('Cause', h.esc(job.causeLabel || 'none recorded'))
    + (source.causeDetail ? row('Cause detail', h.esc(source.causeDetail)) : '') + '</dl>';
  const transcript = source.hasTranscript ? `<a class="btn" data-job-transcript href="/jobs/${h.esc(job.fullId)}">${job.status === 'running' ? 'Watch live' : 'Open transcript'}</a>` : '<span class="sub">No transcript was kept.</span>';
  const note = source.overseer ? `<pre class="overseer-note" data-job-overseer>${h.esc(source.overseer)}</pre>` : '<p class="sub">No overseer note for this job.</p>';
  return `<div data-job-panel="${h.esc(job.id)}"><h3>Job ${h.esc(job.id)}</h3>${record}<div class="acts">${transcript}</div>`
    + `<h4>Postcondition</h4>${postcondition(source, h)}<h4>Overseer note</h4>${note}`
    + `<h4>Other jobs on this item</h4>${others(job, rows, filters, h)}<h4>Actions</h4>${actions(job, view, h)}</div>`;
}
