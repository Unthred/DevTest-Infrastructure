// Issue #1248: the router of the versioned read contract under /api/v1/. It answers every path below that prefix, so an unknown path is a
// JSON 404 and never falls through to the pages. Read models are found by listing the models folder when the router is created; a schema is
// served only if its exact file name is in the list built from the schemas folder then. No part of the request is joined to a directory path.
import fs from 'node:fs';
import { envelope, CONTRACT } from './envelope.mjs';

const PREFIX = '/api/v1/';
const SCHEMAS_ROUTE = `${PREFIX}schemas/`;
const JSON_TYPE = 'application/json; charset=utf-8';
const hasModelShape = m => typeof m.name === 'string' && typeof m.path === 'string' && typeof m.schema === 'string' && typeof m.build === 'function';

async function loadModels(dir) {
  const models = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()) {
    const mod = await import(new URL(file, dir));
    if (hasModelShape(mod)) models.push(mod);
    else console.error(`api: ${file} does not export name, path, schema and build; skipped (issue #1248)`);
  }
  return models;
}

function loadSchemas(dir) {
  const schemas = new Map();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) schemas.set(file, fs.readFileSync(new URL(file, dir), 'utf8'));
  return schemas;
}

// modelsDir and schemasDir are directory URLs. headers are the dashboard's security headers. getView resolves the prepared view.
export function createApiRouter({ modelsDir, schemasDir, headers, allowedHost, now, tickAt, staleAfterMs, coreVersion, getView }) {
  const schemas = loadSchemas(schemasDir);
  const ready = loadModels(modelsDir);
  const reply = (req, res, code, type, body, extra = {}) => {
    res.writeHead(code, { ...headers, 'content-type': type, 'foreman-contract': CONTRACT, ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const fail = (req, res, code, errorCode, text, extra) => reply(req, res, code, JSON_TYPE, JSON.stringify({ error: { code: errorCode, text } }), extra);

  const answerModel = async (req, res, model, models) => {
    const context = { now: now(), coreVersion: coreVersion(), models };
    const view = model.usesView === false ? null : await getView();
    const data = model.build(view, context);
    const body = envelope({ model: model.name, data, now: context.now, tickAt: tickAt(), staleAfterMs });
    return reply(req, res, 200, JSON_TYPE, JSON.stringify(body));
  };

  return {
    owns: path => path.startsWith(PREFIX),
    async handle(req, res, path) {
      if (req.headers.host !== allowedHost) return fail(req, res, 421, 'unexpected_host', 'The request arrived with a Host this dashboard does not serve.');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return fail(req, res, 405, 'method_not_allowed', 'The contract is read-only: use GET or HEAD.', { allow: 'GET, HEAD' });
      }
      try {
        if (path.startsWith(SCHEMAS_ROUTE)) {
          const text = schemas.get(path.slice(SCHEMAS_ROUTE.length));
          return text === undefined ? fail(req, res, 404, 'not_found', 'No such schema.') : reply(req, res, 200, JSON_TYPE, text);
        }
        const models = await ready;
        const model = models.find(m => `${PREFIX}${m.path}` === path);
        if (!model) return fail(req, res, 404, 'not_found', 'No such path under /api/v1/.');
        return await answerModel(req, res, model, models);
      } catch (error) {
        console.error(`api: ${path} failed (issue #1248): ${error?.message || error}`);
        return fail(req, res, 500, 'internal_error', 'The read model could not be built.');
      }
    },
  };
}
