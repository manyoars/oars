// Writes openapi/public.json: the operations listed in openapi/public-operations.json, taken from a source OpenAPI document
// (aor-platform's committed api-specs/openapi.json), with the components they reference and nothing else.
//
//   node scripts/openapi-public.mjs <source openapi.json> [--operations <file>] [--out <file>]
//
// Exit 0: written. Exit 1: the source or the list is unusable, a listed operationId is not in the source (each one is
// named), or a $ref points at a component the source lacks. Exit 2: bad usage. The output is deterministic: object keys
// sorted at every depth, two-space indent, one trailing newline, and no path of the machine that ran it. Its info.title
// and info.description are fixed in this file; info.version is the source's.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** @typedef {import('./json-types.js').JsonValue} JsonValue */
/** @typedef {import('./json-types.js').JsonObject} JsonObject */

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The source's title and description name the platform's internal services, so the public spec states its own; only the
// version is carried over. The public spec E32 produces replaces this file whole.
const PUBLIC_TITLE = 'Many Oars API';
const PUBLIC_DESCRIPTION = 'The AOR platform calls that the Many Oars CLI and starter templates make: deploy a workload, read it, exchange a token, set prices and customers, reserve and settle credits, take a payment.';

/**
 * @param {unknown} value
 * @returns {value is JsonObject}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {JsonObject} object
 * @returns {JsonObject} a copy with the keys of every object below it sorted
 */
const sortObject = (object) =>
  Object.fromEntries(Object.keys(object).sort().map((key) => [key, sortKeys(object[key] ?? null)]));

/**
 * @param {JsonValue} value
 * @returns {JsonValue}
 */
const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  return isObject(value) ? sortObject(value) : value;
};

/**
 * @param {string} ref a `#/components/<section>/<name>` reference
 * @returns {{ section: string, name: string }}
 */
const parseRef = (ref) => {
  const match = /^#\/components\/([^/]+)\/(.+)$/.exec(ref);
  if (match === null) throw new Error(`unsupported $ref ${ref}: only #/components/<section>/<name> is followed`);
  const [, section = '', pointer = ''] = match;
  return { section, name: decodeURIComponent(pointer).replaceAll('~1', '/').replaceAll('~0', '~') };
};

/**
 * @param {JsonValue} node
 * @param {Set<string>} refs collects every `$ref` below `node`
 * @param {Set<string>} schemes collects every security scheme named by a `security` requirement below `node`
 */
const collect = (node, refs, schemes) => {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, refs, schemes);
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') refs.add(value);
    else if (key === 'security' && Array.isArray(value)) {
      for (const requirement of value) {
        if (isObject(requirement)) for (const scheme of Object.keys(requirement)) schemes.add(scheme);
      }
    } else collect(value, refs, schemes);
  }
};

/**
 * @param {JsonObject} source a parsed OpenAPI document
 * @param {string[]} operationIds the operations to keep
 * @returns {JsonObject} the filtered document, keys sorted
 */
const filterSpec = (source, operationIds) => {
  const wanted = new Set(operationIds);
  const found = new Set();
  /** @type {JsonObject} */
  const paths = {};
  const sourcePaths = source['paths'];
  for (const [path, item] of Object.entries(isObject(sourcePaths) ? sourcePaths : {})) {
    if (!isObject(item)) continue;
    /** @type {JsonObject} */
    const kept = {};
    let keptOperation = false;
    for (const [key, value] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(key)) {
        kept[key] = value;
      } else if (isObject(value) && typeof value['operationId'] === 'string' && wanted.has(value['operationId'])) {
        kept[key] = value;
        found.add(value['operationId']);
        keptOperation = true;
      }
    }
    if (keptOperation) paths[path] = kept;
  }
  const missing = operationIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`operationId not found in the source: ${missing.join(', ')}`);

  const refs = new Set();
  const schemes = new Set();
  collect(paths, refs, schemes);
  if (Array.isArray(source['security'])) collect({ security: source['security'] }, refs, schemes);

  const sourceComponents = isObject(source['components']) ? source['components'] : {};
  /** @type {{ [section: string]: JsonObject }} */
  const components = {};
  /** @type {(section: string, name: string) => void} */
  const add = (section, name) => {
    const sourceSection = sourceComponents[section];
    const component = isObject(sourceSection) ? sourceSection[name] : undefined;
    if (component === undefined) throw new Error(`$ref #/components/${section}/${name} not found in the source`);
    components[section] ??= {};
    if (name in components[section]) return;
    components[section][name] = component;
    const inner = new Set();
    collect(component, inner, schemes);
    for (const ref of inner) {
      const target = parseRef(ref);
      add(target.section, target.name);
    }
  };
  for (const ref of refs) {
    const target = parseRef(ref);
    add(target.section, target.name);
  }
  for (const scheme of schemes) add('securitySchemes', scheme);

  const usedTags = new Set();
  for (const item of Object.values(paths)) {
    if (!isObject(item)) continue;
    for (const [key, operation] of Object.entries(item)) {
      const tags = HTTP_METHODS.includes(key) && isObject(operation) ? operation['tags'] : undefined;
      if (Array.isArray(tags)) for (const tag of tags) usedTags.add(tag);
    }
  }
  const sourceTags = Array.isArray(source['tags']) ? source['tags'] : [];
  /** @type {JsonObject} */
  const result = {
    openapi: source['openapi'] ?? null,
    info: { title: PUBLIC_TITLE, description: PUBLIC_DESCRIPTION, version: isObject(source['info']) ? (source['info']['version'] ?? null) : null },
    tags: sourceTags.filter((tag) => isObject(tag) && usedTags.has(tag['name'])),
    paths,
    components,
  };
  if (Array.isArray(source['security'])) result['security'] = source['security'];
  return sortObject(result);
};

/**
 * @param {string} path
 * @returns {JsonValue}
 */
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
};

const run = () => {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        operations: { type: 'string', default: resolve(root, 'openapi/public-operations.json') },
        out: { type: 'string', default: resolve(root, 'openapi/public.json') },
      },
    });
  } catch (error) {
    console.error(`openapi-public: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const [sourcePath, ...extra] = parsed.positionals;
  if (sourcePath === undefined || extra.length > 0) {
    console.error('usage: node scripts/openapi-public.mjs <source openapi.json> [--operations <file>] [--out <file>]');
    return 2;
  }
  try {
    const source = readJson(sourcePath);
    const operations = readJson(parsed.values.operations);
    if (!isObject(source)) throw new Error(`${sourcePath} is not an OpenAPI document (a JSON object)`);
    if (!Array.isArray(operations) || operations.length === 0 || !operations.every((id) => typeof id === 'string' && id !== '')) {
      throw new Error(`${parsed.values.operations} must be a non-empty JSON array of operationId strings`);
    }
    const spec = filterSpec(source, operations.filter((id) => typeof id === 'string'));
    mkdirSync(dirname(parsed.values.out), { recursive: true });
    writeFileSync(parsed.values.out, `${JSON.stringify(spec, null, 2)}\n`);
    return 0;
  } catch (error) {
    console.error(`openapi-public: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
};

process.exitCode = run();
