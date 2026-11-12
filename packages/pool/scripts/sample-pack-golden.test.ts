// docs/pool-deposit-title.md section 5, brief 2: without --deposits the fixture pack is byte for byte what origin/main built.
// The golden is made by running this file (with GOLDEN_WRITE=1) against origin/main's sample-pack.ts, never against a changed one.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { deposit, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { buildPack } from './sample-pack.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-pack-golden.json');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const S = (n: number): string => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const line = (value: object): string => JSON.stringify(value);
const at = (n: number): string => `2026-06-01T10:00:${String(n).padStart(2, '0')}.000Z`;
const uuidOf = (session: string, kind: 'a' | 'b', n: number): string => `${session.slice(0, 8)}-${kind}${String(n).padStart(3, '0')}-4222-8222-222222222222`;
const session = (id: string, cwd: string, prompt: string, reply: string): string[] => [
  line({ type: 'user', uuid: uuidOf(id, 'b', 1), parentUuid: null, isSidechain: false, timestamp: at(1), version: '2.1.300', sessionId: id, cwd, message: { role: 'user', content: prompt } }),
  line({ type: 'assistant', uuid: uuidOf(id, 'a', 1), parentUuid: uuidOf(id, 'b', 1), isSidechain: false, timestamp: at(2), version: '2.1.300', sessionId: id, requestId: `req_011C${id.slice(0, 8)}x1`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: reply }], usage: { input_tokens: 10, output_tokens: 20 } } }),
];

const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));

it('without --deposits the fixture pack is byte for byte the same', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oars-pack-golden-'));
  dirs.push(root);
  const projectsRoot = join(root, 'projects');
  const cwd = join(root, 'work', 'app');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, '.git', 'config'), `[remote "origin"]\n\turl = https://example.com/acme/app.git\n`);
  const put = (project: string, id: string, lines: readonly string[]): void => {
    mkdirSync(join(projectsRoot, project), { recursive: true });
    writeFileSync(join(projectsRoot, project, `${id}.jsonl`), `${lines.join('\n')}\n`);
  };
  put('-work-oars', S(1), session(S(1), cwd, 'add a test for the parser', 'added'));
  put('-work-shop-web', S(2), session(S(2), cwd, 'fix the page layout', 'fixed'));
  put('-tmp-scratch', S(3), session(S(3), cwd, 'try this', 'tried'));
  const terms = join(root, 'terms.txt');
  writeFileSync(terms, 'zorblax\n');
  const owners = join(root, 'owners.json');
  writeFileSync(owners, JSON.stringify([{ folder: '*-oars*', owner: 'Many Oars Co.', license: 'Apache-2.0' }, { folder: '*-shop*', owner: 'Example Shop Co.', license: null }]));
  const indexKey = join(root, 'index.key');
  writeFileSync(indexKey, 'ab'.repeat(32));
  const runtime: SessionsRuntime = { storeDir: join(root, 'store'), projectsRoot, sources: [], stdin: process.stdin, stdout: { write: () => true } };
  // The store's salt is random per store; a fixed one makes the repository keys and the batch root repeatable.
  mkdirSync(runtime.storeDir, { recursive: true });
  writeFileSync(join(runtime.storeDir, 'salt'), 'cd'.repeat(16));
  await deposit(runtime, { allow: [], redactDomains: [], now: () => Date.parse('2026-06-10T00:00:00Z') });
  const out = join(root, 'pack');
  await buildPack(runtime, { terms, owners, indexKey, buyerKey: 'sample', out, size: 25, seed: '1', minTurns: 1 });
  const entries: [string, string][] = [];
  for (const file of filesUnder(out).sort()) {
    const name = relative(out, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    // The temp folder's name is the one thing a run adds, and it reaches the working directory and the hash over the lines (a path differs by platform); the build time and duration are not content.
    entries.push([name, (name === 'pack.json' ? text.replace(/"built": "[^"]*"/, '"built": "-"').replace(/"elapsedMs": \d+/, '"elapsedMs": 0') : text).split(JSON.stringify(root).slice(1, -1)).join('<root>').split(root).join('<root>').split(root.split(sep).join('/')).join('<root>').replace(/oars-pack-golden-[A-Za-z0-9]+/g, 'oars-pack-golden-X').replace(/"cwd":"[^"]*"/g, '"cwd":"<cwd>"').replace(/"merkleRoot": "[0-9a-f]+"/g, '"merkleRoot": "<root-hash>"')]);
  }
  const pack = Object.fromEntries(entries);
  expect(Object.keys(pack).length).toBeGreaterThan(3);
  if (process.env['GOLDEN_WRITE'] === '1') {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify(pack, null, 2)}\n`);
  }
  expect(pack).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
});
