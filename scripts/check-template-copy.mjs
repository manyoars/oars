// Proves what a developer gets: a copy of a starter template, made outside the monorepo, installs the packed
// @manyoars/oars-client in place of the registry version and passes its own unit tests. Packs the client (its prepack builds
// dist/), copies each template by the copy rule in scripts/template-copy.mjs into a temp folder, npm-installs it there with
// no lockfile and no workspace, and runs `npm run typecheck` and `npm test`.
//
//   node scripts/check-template-copy.mjs [template ...]     (default: every template; npm run check:template-copy)
//
// Exit 0: every copy installed the packed client and passed. Exit 1: a step failed; stderr has its output. The installs take
// about as long as `npm ci` does, so CI runs this in its own job and `just check` does not.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTemplate } from './template-copy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = ['paid-api', 'per-task-agent'];
const TARBALL = 'oars-client.tgz';

// npm reads npm_config_* from its environment; a copy must install as a developer's shell would, not as this run's npm script.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith('npm_')));

/**
 * @param {string} command one command line, run through the shell (npm is npm.cmd on Windows)
 * @param {string} cwd
 * @returns {string} stdout
 */
const run = (command, cwd) => {
  const result = spawnSync(command, { cwd, env, shell: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`\`${command}\` exited ${String(result.status)} in ${cwd}\n${result.stdout}${result.stderr}`);
  return result.stdout;
};

/** @param {string} path @returns {string} */
const versionAt = (path) => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version;

const names = process.argv.length > 2 ? process.argv.slice(2) : TEMPLATES;
const unknown = names.filter((name) => !TEMPLATES.includes(name));
if (unknown.length > 0) {
  console.error(`unknown template ${unknown.join(', ')}; the templates are ${TEMPLATES.join(', ')}`);
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'oars-copy-check-'));
try {
  const packed = join(scratch, 'packed');
  mkdirSync(packed);
  run(`npm pack -w packages/client --pack-destination "${packed}" --quiet`, root);
  const tarball = readdirSync(packed).find((file) => file.endsWith('.tgz'));
  if (tarball === undefined) throw new Error(`npm pack left no tarball in ${packed}`);
  const version = versionAt(join(root, 'packages', 'client'));
  console.log(`packed ${tarball}`);

  for (const name of names) {
    const copy = join(scratch, name);
    mkdirSync(copy);
    copyTemplate(join(root, 'templates', name), copy, `file:./${TARBALL}`);
    copyFileSync(join(packed, tarball), join(copy, TARBALL));
    run('npm install --no-audit --no-fund --loglevel=error', copy);

    // A real directory holding the built package, not a link back into the monorepo.
    const installed = join(copy, 'node_modules', '@manyoars', 'oars-client');
    if (lstatSync(installed).isSymbolicLink()) throw new Error(`${name}: ${installed} is a link, not the packed client`);
    if (versionAt(installed) !== version || !existsSync(join(installed, 'dist', 'index.js')) || existsSync(join(installed, 'src'))) {
      throw new Error(`${name}: ${installed} is not the packed client ${version} (dist/index.js present, no src/)`);
    }

    run('npm run typecheck', copy);
    const summary = run('npm test', copy)
      .split('\n')
      .filter((line) => /^\s*(Test Files|Tests)\s/.test(line))
      .map((line) => line.trim())
      .join('; ');
    console.log(`${name}: installed oars-client ${version} from the tarball outside the monorepo; typecheck clean; ${summary}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
