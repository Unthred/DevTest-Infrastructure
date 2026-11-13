// Issue #1248: the router of the versioned read contract under /api/v1/. It answers every path below that prefix, so an unknown path is a
// JSON 404 and never falls through to the pages. Read models and route modules are found by listing their folders when the router is created;
// a schema is served only if its exact file name is in the list built from the schemas folder then. No part of the request is joined to a path.
// Issue #1251: extension points so later items add files only: a context with query, params, root and config; braced path segments; async
// builds and notFound; route modules (a reply the envelope does not fit) in routes/; and a guard handing the dashboard's write checks over.
import fs from 'node:fs';
import { envelope, CONTRACT, INITIAL_CURSOR } from './envelope.mjs';

const PREFIX = '/api/v1/';
const SCHEMAS_ROUTE = `${PREFIX}schemas/`;
const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_QUERY_NAMES = 20;
const MAX_QUERY_VALUE = 200;
const SEGMENT_VALUE = /^[A-Za-z0-9._-]{1,64}$/;
const BRACED = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/;
const isText = value => typeof value === 'string';
const hasModelShape = m => isText(m.name) && isText(m.path) && isText(m.schema) && typeof m.build === 'function';
const hasRouteShape = m => typeof m.name === 'string' && ['GET', 'POST'].includes(m.method) && typeof m.path === 'string' && typeof m.handle === 'function';

// A build function returns this to make the router answer 404 as JSON with the code not_found.
class NotFound { constructor(text) { this.text = text; } }
export const notFound = text => new NotFound(String(text ?? 'Not found.'));

// Issue #1307: a build function returns this to refuse a query value; the router answers 400 as JSON with the given code.
class BadRequest { constructor(code, text) { this.code = code; this.text = text; } }
export const badRequest = (code, text) => new BadRequest(String(code), String(text));

// A pattern segment in braces takes one request segment of safe characters; every other segment must be equal. Returns the params or null.
export function matchPath(pattern, path) {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i += 1) {
    const braced = BRACED.exec(want[i]);
    if (!braced) {
      if (want[i] !== got[i]) return null;
    } else if (SEGMENT_VALUE.test(got[i])) params[braced[1]] = got[i];
    else return null;
  }
  return params;
}

// The first 20 distinct names, each value a string cut at 200 characters. Own data properties only, so a name like __proto__ is just data.
export function parseQuery(search) {
  const entries = [];
  for (const [name, value] of new URLSearchParams(search)) {
    if (entries.length >= MAX_QUERY_NAMES) break;
    if (!entries.some(([seen]) => seen === name)) entries.push([name, value.slice(0, MAX_QUERY_VALUE)]);
  }
  return Object.fromEntries(entries);
}

async function loadModules(dir, hasShape, shapeText) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()) {
    const mod = await import(new URL(file, dir));
    if (hasShape(mod)) found.push(mod);
    else console.error(`api: ${file} does not export ${shapeText}; skipped (issue #1248)`);
  }
  return found;
}

// The envelope cursor: from the first route module that exports cursor(root), else the fixed initial one.
function cursorOf(routes, root) {
  const source = routes.find(r => typeof r.cursor === 'function');
  const value = source ? source.cursor(root) : null;
  return typeof value === 'string' && value ? value : INITIAL_CURSOR;
}

function firstMatch(list, path, method) {
  for (const item of list) {
    if (method && item.method !== method) continue;
    const params = matchPath(`${PREFIX}${item.path}`, path);
    if (params) return { item, params };
  }
  return null;
}

function loadSchemas(dir) {
  const schemas = new Map();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) schemas.set(file, fs.readFileSync(new URL(file, dir), 'utf8'));
  return schemas;
}

// HEAD on a GET route: same status and headers, and whatever the route writes as a body is dropped.
function withoutBody(res) {
  return new Proxy(res, { get: (target, prop) => {
    if (prop === 'write') return () => true;
    if (prop === 'end') return () => target.end();
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

// modelsDir, routesDir and schemasDir are directory URLs. headers are the dashboard's security headers. getView resolves the prepared view.
// root is the state root, getConfig returns the current validated configuration and guard holds the dashboard's write checks.
export function createApiRouter({
  modelsDir, routesDir, schemasDir, headers, allowedHost, now, tickAt, staleAfterMs, coreVersion, getView, root, getConfig, guard,
}) {
  const schemas = loadSchemas(schemasDir);
  const ready = Promise.all([
    loadModules(modelsDir, hasModelShape, 'name, path, schema and build'),
    loadModules(routesDir, hasRouteShape, 'name, method, path and handle'),
  ]);
  const reply = (req, res, code, type, body, extra = {}) => {
    res.writeHead(code, { ...headers, 'content-type': type, 'foreman-contract': CONTRACT, ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const fail = (req, res, code, errorCode, text, extra) => reply(req, res, code, JSON_TYPE, JSON.stringify({ error: { code: errorCode, text } }), extra);

  const baseContext = (url, params, models, routes) => ({
    now: now(), coreVersion: coreVersion(), models, routes, query: parseQuery(url.search), params, root, config: getConfig(),
  });

  const answerModel = async (req, res, model, context, routes) => {
    const view = model.usesView === false ? null : await getView();
    const data = await model.build(view, context);
    if (data instanceof NotFound) return fail(req, res, 404, 'not_found', data.text);
    if (data instanceof BadRequest) return fail(req, res, 400, data.code, data.text);
    const body = envelope({ model: model.name, data, now: context.now, tickAt: tickAt(), staleAfterMs, cursor: cursorOf(routes, root) });
    return reply(req, res, 200, JSON_TYPE, JSON.stringify(body));
  };

  const dispatch = async (req, res, path) => {
    const url = new URL(req.url || '/', 'http://contract.invalid');
    const [models, routes] = await ready;
    const readMethod = req.method === 'GET' || req.method === 'HEAD';
    const hit = firstMatch(routes, path, req.method === 'HEAD' ? 'GET' : req.method);
    if (hit) {
      const context = { ...baseContext(url, hit.params, models, routes), headers, reply, fail, guard };
      return hit.item.handle(req, req.method === 'HEAD' ? withoutBody(res) : res, context);
    }
    if (!readMethod) return fail(req, res, 405, 'method_not_allowed', 'The contract is read-only: use GET or HEAD.', { allow: 'GET, HEAD' });
    if (path.startsWith(SCHEMAS_ROUTE)) {
      const text = schemas.get(path.slice(SCHEMAS_ROUTE.length));
      return text === undefined ? fail(req, res, 404, 'not_found', 'No such schema.') : reply(req, res, 200, JSON_TYPE, text);
    }
    const found = firstMatch(models, path);
    if (!found) return fail(req, res, 404, 'not_found', 'No such path under /api/v1/.');
    return answerModel(req, res, found.item, baseContext(url, found.params, models, routes), routes);
  };

  return {
    owns: path => path.startsWith(PREFIX),
    async handle(req, res, path) {
      if (req.headers.host !== allowedHost) return fail(req, res, 421, 'unexpected_host', 'The request arrived with a Host this dashboard does not serve.');
      try {
        return await dispatch(req, res, path);
      } catch (error) {
        console.error(`api: ${path} failed (issue #1248): ${error?.message || error}`);
        if (res.headersSent) return res.end();
        return fail(req, res, 500, 'internal_error', 'The read model could not be built.');
      }
    },
  };
}
