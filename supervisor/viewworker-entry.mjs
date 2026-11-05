// Issue #467: worker-thread entry. Runs the dashboard build for supervisor/viewworker.mjs. Read-only; no model or GitHub call.
import { parentPort } from 'node:worker_threads';
import { currentView } from './dashserver.mjs';

parentPort.on('message', async ({ id, opts }) => {
  try { parentPort.postMessage({ id, json: JSON.stringify(await currentView(opts)) }); }
  catch (error) { parentPort.postMessage({ id, error: String(error?.message || error).slice(0, 300) }); }
});
