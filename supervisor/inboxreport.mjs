// Issue #1147: the report contract every Inbox prompt carries, and the check of the named report when the job ends.
// The text lives in inbox-report-contract.txt. The marker rule is the report reader's (foreman-mcp/reports.mjs): the LAST non-blank line,
// trimmed, is the marker. It is restated here because copies of supervisor/ used by tests do not carry foreman-mcp; a test pins the two together.
import fs from 'node:fs';
import path from 'node:path';

export const FINISHED_MARKER = '<!-- foreman-report: finished -->';
const TAIL_BYTES = 512;
const CONTRACT_FILE = new URL('./inbox-report-contract.txt', import.meta.url);

export const reportNameFor = inboxId => `inbox-${String(inboxId).slice(0, 8)}.md`;

export function renderContract({ reportsDir, reportName }) {
  const values = { REPORT_FILE: reportName, REPORTS_DIR: reportsDir, MARKER: FINISHED_MARKER };
  return fs.readFileSync(CONTRACT_FILE, 'utf8').trim().replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
}

// Appends the contract once. No reports folder configured means no named report, so the prompt is returned unchanged.
export function withReportContract(prompt, { reportsDir, reportName }) {
  if (!reportsDir || !reportName) return prompt;
  const contract = renderContract({ reportsDir, reportName });
  return prompt.includes(contract) ? prompt : `${prompt}\n\n${contract}`;
}

// 'finished' | 'unfinished' | 'missing'. Only the tail is read, so a large report is judged the same way as the reader judges it.
export function reportState({ reportsDir, reportName }) {
  let fd;
  try {
    fd = fs.openSync(path.join(reportsDir, reportName), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, size - len);
    const last = buf.subarray(0, n).toString('utf8').trimEnd().split('\n').pop().trim();
    return last === FINISHED_MARKER ? 'finished' : 'unfinished';
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : 'unfinished';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

// The sentence added to an Inbox result; empty when the report is finished or the job had no named report.
export function reportNote(job) {
  if (!job?.reportName || !job.reportsDir) return '';
  const state = reportState(job);
  if (state === 'finished') return '';
  if (state === 'missing') return `Report ${job.reportName} is missing from the reports folder.`;
  return `Report ${job.reportName} is unfinished: its final line is not ${FINISHED_MARKER}.`;
}
