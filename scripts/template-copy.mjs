// The copy a developer makes of a starter template (lead 30/31). The monorepo-only tests, their vitest configs, the image's
// dockerignore and the dev dependencies only those tests use are left behind; everything else is the template as shipped.
// scripts/check-template-copy.mjs installs and tests such a copy outside the monorepo.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** @typedef {import('./json-types.js').JsonObject} JsonObject */

const DROPPED_PATHS = new Set(['test/monorepo', 'Dockerfile.dockerignore', 'vitest.monorepo.config.ts', 'vitest.smoke.config.ts']);
// parse5 (per-task-agent) stays: src/audit.ts imports it. Only the monorepo tests import these three.
const DROPPED_DEV_DEPENDENCIES = ['@stoplight/prism-cli', 'ajv', 'yaml'];
// Their vitest configs are dropped, so a script that runs them would only fail.
const DROPPED_SCRIPTS = ['test:monorepo', 'test:smoke'];
const CLIENT = '@manyoars/oars-client';

/** @param {unknown} value @returns {value is JsonObject} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {JsonObject} manifest
 * @param {string} key
 * @returns {JsonObject}
 */
const section = (manifest, key) => {
  const value = manifest[key];
  return isObject(value) ? value : {};
};

/**
 * Copies a template folder to `destination` (which must exist) and rewrites the copy's package.json.
 * @param {string} source a folder under templates/
 * @param {string} destination
 * @param {string} client the dependency spec to install the client from in place of the template's version range
 */
export const copyTemplate = (source, destination, client) => {
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => {
      const inside = relative(source, path).split(sep).join('/');
      return !DROPPED_PATHS.has(inside) && inside !== 'node_modules' && inside !== 'dist';
    },
  });

  const manifestPath = join(destination, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const devDependencies = Object.fromEntries(Object.entries(section(manifest, 'devDependencies')).filter(([name]) => !DROPPED_DEV_DEPENDENCIES.includes(name)));
  const scripts = Object.fromEntries(Object.entries(section(manifest, 'scripts')).filter(([name]) => !DROPPED_SCRIPTS.includes(name)));
  const dependencies = { ...section(manifest, 'dependencies'), [CLIENT]: client };
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, scripts, dependencies, devDependencies }, null, 2)}\n`);
};
