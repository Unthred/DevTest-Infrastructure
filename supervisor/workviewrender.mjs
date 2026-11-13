// Issue #1224: the Work page's Table and Board. The server renders the view switch and the rows as JSON; the browser script
// (dashui/workview-ui.mjs) draws the table, the board, the filters and the side panel from them. One call from dashrender.mjs.
import { buildWorkRows } from './workrows.mjs';
import { VIEWS } from './dashui/worktable.mjs';
import { switchHtml } from './dashui/viewswitch.mjs';

// JSON inside a <script> block: "<" and the two line separators can never end it or break the parse.
export const jsonForScript = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function workViewHtml(view) {
  const data = buildWorkRows(view);
  return `<div class="wv" data-workview>${switchHtml(VIEWS, 'cards', 'How to show the queue')}
<p class="sub wv-hint">Queue cards is the list below. Table and Board show every open issue and pull request with all its queue fields.</p>
<div class="wv-body" hidden></div>
<noscript><p class="sub">Table and Board need JavaScript; the queue cards below show the same queue.</p></noscript>
<script type="application/json" id="wv-data">${jsonForScript(data)}</script>
<script type="module" src="/static/workview-ui.mjs"></script></div>`;
}
