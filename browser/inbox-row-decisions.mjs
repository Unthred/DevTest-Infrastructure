// Runs INSIDE the pinned Playwright container, called by inbox-row-actions-scenario.mjs in its decisions mode (issue #1477): the Inbox rows of
// the four decision cards of 14 Nov 2026, in the Table, Compact list and Cards views, and the real buttons pressed with and without script.
// `check(name, ok, detail)` records one result; `open(scripted)` returns a new page on the real /inbox route.
import { PROFILES } from './capture.mjs';

const WANT = {
  'split-stuck-1175': ['Approve split', 'Reject split', 'Unpark'],
  'fixlimit-1146': ['Extra fix round', 'Close as superseded', 'Unpark'],
  'split-parked-1139': ['Unpark'],
  'homeowner-pr-1192': ['Park'],
};
const COOLDOWN_MS = 1200;   // the route allows one decision a second
const FILTER = '?state=waiting';

export async function runDecisions({ ctx, port, profile, check }) {
  const base = `http://127.0.0.1:${port}`;
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  const posts = [];
  page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
  await page.goto(`${base}/inbox${FILTER}`, { waitUntil: 'networkidle' });
  const row = (view, id) => (view === 'Table' ? page.locator(`.iv-table tbody tr[data-id="${id}"]`) : view === 'Compact list' ? page.locator(`.iv-crow[data-id="${id}"]`) : page.locator(`.inbox-item[data-inbox="${id}"]`));
  const controls = (view, id) => row(view, id).locator('button.decision-control').allTextContents();
  const view = label => page.getByRole('button', { name: label, exact: true }).click();

  for (const label of ['Table', 'Compact list', 'Cards']) {
    await view(label);
    for (const [id, want] of Object.entries(WANT)) {
      const got = await controls(label, id);
      check(`${label}: ${id} shows exactly its controls`, got.join('|') === want.join('|'), got.join('|'));
      check(`${label}: ${id} shows its buttons`, await row(label, id).locator('button.decision-control').first().isVisible());
    }
    const input = row(label, 'fixlimit-1146').locator('input[name="superseded_by"]');
    check(`${label}: Close as superseded has its input`, (await input.count()) === 1 && await input.isVisible());
    if (PROFILES[profile].viewport.width < 640) {
      const heights = await row(label, 'split-stuck-1175').locator('button.decision-control').evaluateAll(bs => bs.map(b => b.getBoundingClientRect().height));
      check(`${label}: the buttons are at least 44 px high at phone width`, heights.every(h => h >= 44), heights.join());
    }
  }
  await view('Table');
  const prompt = page.locator('.iv-table tbody tr[data-id]:not([data-id*="-"])').first();
  check('a prompt row beside the cards still shows Approve and Reject', (await prompt.locator('button').allTextContents()).join() === 'Approve,Reject');

  // Boundary: Close as superseded cannot be sent with an empty input (the browser's own required check stops the form).
  const before = posts.length;
  await row('Table', 'fixlimit-1146').getByRole('button', { name: 'Close as superseded' }).click();
  await page.waitForTimeout(300);
  check('Close as superseded with an empty input sends nothing', posts.length === before && new URL(page.url()).pathname === '/inbox');
  check('the empty input is flagged invalid', await row('Table', 'fixlimit-1146').locator('input[name="superseded_by"]').evaluate(i => !i.validity.valid));

  // Valid: Reject split from the Table row; the viewer stays on /inbox at Waiting for approval and the Table; the row then shows Working.
  const reply = page.waitForResponse(r => r.url().endsWith('/decision') && r.request().method() === 'POST');
  await row('Table', 'split-stuck-1175').getByRole('button', { name: 'Reject split' }).click();
  const answer = await (await reply).json();
  check('the post answers done for Reject split', answer.ok === true && /Reject split recorded/.test(answer.message || ''), JSON.stringify(answer));
  await row('Table', 'split-stuck-1175').locator('.decision-status[data-state="working"]').waitFor({ timeout: 12000 });
  const here = new URL(page.url());
  check('the page is still /inbox on Waiting for approval', here.pathname === '/inbox' && here.search === FILTER, here.pathname + here.search);
  check('the Table is still the view shown', await page.locator('[data-pane="table"]').isVisible());
  check('the row shows Working', /Working: Reject split recorded/.test(await row('Table', 'split-stuck-1175').locator('.decision-status').textContent()));
  const left = await controls('Table', 'split-stuck-1175');
  check('the Reject split button is gone and the other two stay', left.join('|') === 'Approve split|Unpark', left.join('|'));
  check('the other rows kept their controls', (await controls('Table', 'fixlimit-1146')).length === 3);
  await view('Compact list');
  check('the Compact list row shows Working too', /Working/.test(await row('Compact list', 'split-stuck-1175').locator('.decision-status').textContent()));

  // Without script: the form post returns to the Inbox page at the same filter and the card's row.
  await page.waitForTimeout(COOLDOWN_MS);
  const plain = await (await page.context().browser().newContext({ ...PROFILES[profile], javaScriptEnabled: false, serviceWorkers: 'block', locale: 'en-GB' })).newPage();
  await plain.route('**/*', r => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort('blockedbyclient')));
  await plain.goto(`${base}/inbox${FILTER}`, { waitUntil: 'networkidle' });
  const target = plain.locator('.inbox-item[data-inbox="homeowner-pr-1192"]');
  await target.getByRole('button', { name: 'Park' }).click();
  await plain.waitForLoadState('networkidle');
  const back = new URL(plain.url());
  check('without script the post returns to the Inbox page at the filter and the row', back.pathname === '/inbox' && back.search === FILTER && back.hash === '#att-inbox-homeowner-pr-1192', back.pathname + back.search + back.hash);
  check('without script the row shows Working and no Park button', /Working: Park recorded/.test(await target.locator('.decision-status').textContent()) && (await target.locator('button.decision-control').count()) === 0);
  check('no script errors', errors.length === 0, errors.join('; '));
  return page;
}
