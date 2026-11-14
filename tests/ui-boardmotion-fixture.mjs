// Issue #1313: the fixture liveboard models of the ball travel browser check, built on the model of tests/ui-board-fixture.mjs. Steps:
// base (item 1244 waiting third), start (it runs in claude/opus), land (it landed in Changes asked, one lap), again (the same as base: waiting again, the box empty),
// many (13 jobs run at once).
import { boardFixture } from './ui-board-fixture.mjs';

const REVIEW = { job_id: '6ff7be3f', lane_id: 'claude/opus', job_type: 'review', number: 1244, title: 'Review of pull request 1244', laps: 1 };
const waitingReview = place => ({ place, number: 1244, title: REVIEW.title, job_type: 'review', tied_agent: null, held: null });

export function motionFixture(now, step) {
  const model = boardFixture(now, 'first');
  const started = new Date(now - 2000).toISOString();
  model.landed = model.landed.filter(job => job.job_id !== REVIEW.job_id);
  model.waiting = [...model.waiting.filter(item => item.number !== 1244), waitingReview(3)];
  if (step === 'start') {
    model.waiting.pop();
    model.running.push({ ...REVIEW, started_at: started, typical_seconds: 300 });
  }
  if (step === 'land') {
    model.waiting.pop();
    model.landed.push({ ...REVIEW, ended_at: '2026-11-13T08:45:00Z', box: 'changes_asked', tokens: 5000, cost_pence: 125 });
  }
  if (step === 'many') {
    model.waiting = [];
    for (let index = 0; index < 13; index += 1) {
      model.running.push({ job_id: `many${String(index).padStart(4, '0')}`, lane_id: 'claude/sonnet', job_type: 'implement', number: 3000 + index, title: null, laps: 0,
        started_at: started, typical_seconds: 300 });
    }
  }
  return model;
}
