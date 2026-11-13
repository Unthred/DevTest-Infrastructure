// A small JSON Schema checker for the subset this contract uses. It has no imports, so the same file runs in Node, in a browser
// and in any client's test suite. Supported: $ref (same file and other files by $id), allOf, anyOf, oneOf (as anyOf), type (one or a
// list), enum, const, required, properties, additionalProperties (false or a schema), items, minItems, minimum, maximum, pattern and
// format date-time. Anything else in a schema is ignored, so keep the contract schemas inside this subset.

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeOk = (wanted, v) => { const actual = typeOf(v); return wanted === actual || (wanted === 'number' && actual === 'integer'); };

// schemas: an object of schema documents keyed by their $id (for example 'appbar.schema.json').
export function createValidator(schemas) {
  function resolve(ref, baseId) {
    const [file, fragment = ''] = ref.split('#');
    const id = file || baseId;
    let node = schemas[id];
    if (!node) throw new Error(`unknown schema: ${id}`);
    for (const part of fragment.split('/').filter(Boolean)) node = node == null ? undefined : node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`unresolved reference: ${ref}`);
    return { node, id };
  }

  function check(schema, value, path, id, errors) {
    if (schema === true || schema == null) return;
    if (schema.$ref) { const r = resolve(schema.$ref, id); check(r.node, value, path, r.id, errors); }
    for (const sub of schema.allOf || []) check(sub, value, path, id, errors);
    const any = schema.anyOf || schema.oneOf;
    if (any) {
      const ok = any.some(sub => { const e = []; check(sub, value, path, id, e); return e.length === 0; });
      if (!ok) errors.push(`${path}: matches none of the allowed shapes`);
    }
    if (schema.type !== undefined) {
      const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!wanted.some(t => typeOk(t, value))) { errors.push(`${path}: is ${typeOf(value)}, expected ${wanted.join(' or ')}`); return; }
    }
    if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    if (typeof value === 'string') {
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
      if (schema.format === 'date-time' && !DATE_TIME.test(value)) errors.push(`${path}: is not a UTC date-time ending in Z`);
    }
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: is below ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: is above ${schema.maximum}`);
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: has fewer than ${schema.minItems} items`);
      if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, id, errors));
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}: is missing ${key}`);
      const props = schema.properties || {};
      for (const [key, v] of Object.entries(value)) {
        if (key in props) check(props[key], v, `${path}.${key}`, id, errors);
        else if (schema.additionalProperties === false) errors.push(`${path}: has an unknown field ${key}`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(schema.additionalProperties, v, `${path}.${key}`, id, errors);
      }
    }
  }

  return function validate(schemaId, value) {
    if (!schemas[schemaId]) return [`unknown schema: ${schemaId}`];
    const errors = [];
    try { check(schemas[schemaId], value, '$', schemaId, errors); } catch (error) { errors.push(String(error.message || error)); }
    return errors;
  };
}

// Rules the schemas cannot express. Each returns a list of error strings. These are part of the contract: any core must pass them.
export const INVARIANTS = {
  // No dead ends: anything that waits for the homeowner offers a usable control or says what only he can do.
  overview(model) {
    const errors = [];
    for (const item of model.data.needs_you) {
      if (item.condition.attention !== 'homeowner') errors.push(`needs_you ${item.id}: attention is ${item.condition.attention}, not homeowner (faults and homeowner waits are never mixed)`);
      if (!item.actions.some(a => a.enabled) && !item.step_text && !item.list) errors.push(`needs_you ${item.id}: no enabled action, no step and no list behind it (a dead end)`);
    }
    for (const item of model.data.faults) if (item.condition.attention === 'homeowner') errors.push(`faults ${item.id}: a homeowner wait is listed as a fault`);
    for (const stall of model.data.stalls) if (!stall.condition.reason_code) errors.push(`stall ${stall.agent}: no reason code (an unknown reason must be the code unrecorded, never empty)`);
    return errors;
  },
  appbar(model) {
    const errors = [];
    for (const agent of model.data.agents) for (const key of ['weekly', 'short']) {
      const w = agent[key];
      if (w.state === 'unknown' && (w.used_fraction !== null || !w.reason_code)) errors.push(`agent ${agent.id} ${key}: an unknown window must have no figure and must say why`);
      if (w.state === 'known' && w.used_fraction === null) errors.push(`agent ${agent.id} ${key}: a known window needs a figure`);
    }
    return errors;
  },
  inbox(model) {
    const errors = [];
    for (const item of model.data.items) if (item.state === 'waiting_for_approval' && !item.actions.some(a => a.enabled)) errors.push(`inbox ${item.id}: waits for approval with no enabled action`);
    return errors;
  },
  audit(model) {
    const errors = [];
    for (const entry of model.data.entries) {
      if (entry.actor === 'overseer' && !entry.reason) errors.push(`audit ${entry.id}: an overseer command has no reason`);
      if (entry.outcome === 'refused' && !entry.refusal_code) errors.push(`audit ${entry.id}: a refusal has no code`);
    }
    return errors;
  }
};
