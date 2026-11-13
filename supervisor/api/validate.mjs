// Issue #1248: a small JSON Schema checker with no imports. It supports only: $ref (same file, and other files by $id), allOf, anyOf,
// type (one or a list), enum, const, required, properties, additionalProperties, items, minimum, maximum, pattern and format date-time.
// Any other keyword in a schema is ignored, so the schemas of the contract must stay inside this subset.
// validate(schema, value, schemas) returns a list of error strings, each starting with the path of the fault ('$.data.states[2].group').
// `schemas` maps a file's $id to its parsed schema, so a $ref such as "common.schema.json#/$defs/condition" can be followed.

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;   // the contract allows UTC only, so the Z is part of the format

const typeOf = value => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};
const isType = (value, name) => typeOf(value) === name || (name === 'number' && typeOf(value) === 'integer');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function resolve(ref, root, schemas) {
  const [file, pointer = ''] = ref.split('#');
  let node = file ? schemas[file] : root;
  if (node === undefined) return { error: `unknown schema file ${file}` };
  const rootOfTarget = node;
  for (const part of pointer.split('/').filter(Boolean)) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node === undefined ? { error: `unresolved reference ${ref}` } : { node, root: rootOfTarget };
}

function check(schema, value, path, ctx, errors) {
  if (typeof schema.$ref === 'string') {
    const target = resolve(schema.$ref, ctx.root, ctx.schemas);
    if (target.error) { errors.push(`${path}: ${target.error}`); return; }
    check(target.node, value, path, { ...ctx, root: target.root }, errors);
  }
  for (const sub of schema.allOf || []) check(sub, value, path, ctx, errors);
  if (schema.anyOf && !schema.anyOf.some(sub => validateNode(sub, value, path, ctx).length === 0)) errors.push(`${path}: matches none of the allowed shapes`);
  if (schema.type !== undefined) {
    const names = [].concat(schema.type);
    if (!names.some(name => isType(value, name))) { errors.push(`${path}: expected ${names.join(' or ')}, got ${typeOf(value)}`); return; }
  }
  if (schema.enum && !schema.enum.some(item => same(item, value))) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if ('const' in schema && !same(schema.const, value)) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  checkScalar(schema, value, path, errors);
  if (typeOf(value) === 'object') checkObject(schema, value, path, ctx, errors);
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, ctx, errors));
}

function checkScalar(schema, value, path, errors) {
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} is above the maximum ${schema.maximum}`);
  }
  if (typeof value !== 'string') return;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: "${value}" does not match ${schema.pattern}`);
  const badTime = schema.format === 'date-time' && !(DATE_TIME.test(value) && Number.isFinite(Date.parse(value)));
  if (badTime) errors.push(`${path}: "${value}" is not a UTC date-time ending in Z`);
}

function checkObject(schema, value, path, ctx, errors) {
  for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required field is missing`);
  const props = schema.properties || {};
  for (const [key, sub] of Object.entries(props)) if (Object.hasOwn(value, key)) check(sub, value[key], `${path}.${key}`, ctx, errors);
  if (schema.additionalProperties === undefined || schema.additionalProperties === true) return;
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(props, key)) continue;
    if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown field`);
    else check(schema.additionalProperties, value[key], `${path}.${key}`, ctx, errors);
  }
}

function validateNode(schema, value, path, ctx) {
  const errors = [];
  check(schema, value, path, ctx, errors);
  return errors;
}

export function validate(schema, value, schemas = {}) {
  return validateNode(schema, value, '$', { root: schema, schemas });
}
