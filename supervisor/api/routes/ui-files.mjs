// Issue #1266: GET /api/v1/ui/{file}, the static files of the web UI in supervisor/ui/. The names are listed once when this module loads;
// a request is only looked up in that list and never joined to a directory, so no request text can reach another file.
import fs from 'node:fs';

export const name = 'ui_files';
export const method = 'GET';
export const path = 'ui/{file}';

const UI_DIR = new URL('../../ui/', import.meta.url);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const extensionOf = file => file.slice(file.lastIndexOf('.'));
const listFiles = () => (fs.existsSync(UI_DIR) ? fs.readdirSync(UI_DIR, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name) : []);
const FILES = new Set(listFiles());

export function handle(req, res, context) {
  const file = context.params.file;
  if (!FILES.has(file)) return context.fail(req, res, 404, 'not_found', 'No such UI file.');
  const body = fs.readFileSync(new URL(file, UI_DIR));
  return context.reply(req, res, 200, TYPES[extensionOf(file)] ?? 'application/octet-stream', body, { 'cache-control': 'no-cache' });
}
