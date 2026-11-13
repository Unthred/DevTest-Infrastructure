// Issue #1266: GET /api/v1/ui answers 302 to the shell page, so the address without a file name opens the UI.
export const name = 'ui_index';
export const method = 'GET';
export const path = 'ui';

export const SHELL = '/api/v1/ui/index.html';

export function handle(req, res, context) {
  return context.reply(req, res, 302, 'text/plain; charset=utf-8', `Found: ${SHELL}`, { location: SHELL, 'cache-control': 'no-store' });
}
