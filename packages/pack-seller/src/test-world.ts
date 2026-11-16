import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deposit, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { buildPack } from '../../pool/scripts/sample-pack.js';
import {
  ENV_INDEX_KEY_FILE,
  ENV_OWNERS_FILE,
  ENV_PACKS_DIR,
  ENV_PROJECTS_DIR,
  ENV_STORE_DIR,
  ENV_TERMS_FILE,
  openPackStore,
  type PackInputs,
  type PackStore,
  type StoreOptions,
} from './pack-store.js';

/** The key the operator's own preview was built under; a buyer's key is a different one. */
export const PREVIEW_KEY = 'operator-preview-key';
export const BUYER_KEY = 'buyer-key-ten-characters-or-more';
export const SESSION = '11111111-1111-4111-8111-111111111111';

const dirs: string[] = [];

/** Removes every folder a world made; call it from `afterEach`. */
export const cleanWorlds = (): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

export interface World {
  root: string;
  runtime: SessionsRuntime;
  inputs: PackInputs;
  store: () => Promise<PackStore>;
  open: (options?: StoreOptions) => Promise<PackStore>;
  objections: string;
  deliveries: string;
}

const NL = String.fromCharCode(10);

/**
 * A whole operator machine in a temp folder: a store copy made by `deposit` from a real transcript, a term list, an owners file, an index key, and one pack, `alpha`, with its
 * listing and a preview built by `buildPack` itself. Nothing is written by hand that the code under test produces, and nothing touches a real store: the root is a fresh temp folder
 * and APPDATA is not read (the store and transcripts roots are named explicitly).
 */
export const makeWorld = async (): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'oars-seller-world-'));
  dirs.push(root);
  const cwd = join(root, 'work', 'app');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  // A remote the store records as the session's repository, so the build keeps the session.
  writeFileSync(join(cwd, '.git', 'config'), `[remote "origin"]${String.fromCharCode(10)}${String.fromCharCode(9)}url = https://example.com/acme/app.git${String.fromCharCode(10)}`);
  const projectsDir = join(root, 'projects');
  const project = join(projectsDir, '-work-oars');
  mkdirSync(project, { recursive: true });
  const row = (type: string, uuid: string, parentUuid: string | null, timestamp: string, message: object): string =>
    JSON.stringify({ type, uuid, parentUuid, isSidechain: false, timestamp, version: '2.1.300', sessionId: SESSION, cwd, requestId: 'req_011Cseller0001', message });
  writeFileSync(
    join(project, `${SESSION}.jsonl`),
    [
      row('user', 'aaaaaaaa-b001-4222-8222-222222222222', null, '2026-06-01T10:00:01.000Z', { role: 'user', content: 'add a test' }),
      row('assistant', 'aaaaaaaa-a001-4222-8222-222222222222', 'aaaaaaaa-b001-4222-8222-222222222222', '2026-06-01T10:00:02.000Z', {
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    ].join(NL) + NL,
  );
  const storeDir = join(root, 'store');
  const runtime: SessionsRuntime = { storeDir, projectsRoot: projectsDir, sources: [], stdin: process.stdin, stdout: { write: () => true } };
  await deposit(runtime, { allow: [], redactDomains: [], now: () => Date.parse('2026-06-10T00:00:00Z') });
  const operator = join(root, 'operator');
  mkdirSync(operator);
  const terms = join(operator, 'terms.txt');
  writeFileSync(terms, 'zorblax');
  const owners = join(operator, 'owners.json');
  writeFileSync(owners, JSON.stringify([{ folder: '*-oars*', owner: 'Many Oars Co.', license: 'Apache-2.0' }]));
  const indexKey = join(operator, 'index.key');
  writeFileSync(indexKey, 'ab'.repeat(32));
  const packsDir = join(operator, 'packs');
  mkdirSync(join(packsDir, 'alpha'), { recursive: true });
  writeFileSync(join(packsDir, 'alpha', 'listing.json'), JSON.stringify({ title: 'Alpha pack', size: 5, minTurns: 1 }));
  const counts = await buildPack(runtime, { terms, owners, indexKey, buyerKey: PREVIEW_KEY, out: join(packsDir, 'alpha', 'preview'), size: 5, seed: '1', minTurns: 1 });
  if (counts.emitted === 0) throw new Error('The world fixture built an empty pack.');
  const inputs: PackInputs = { packsDir, terms, owners, indexKey, storeDir, projectsDir };
  const open = (options?: StoreOptions): Promise<PackStore> => openPackStore(inputs, options);
  return { root, runtime, inputs, store: () => open(), open, objections: join(operator, 'objections.jsonl'), deliveries: join(operator, 'deliveries.jsonl') };
};

export const readIfPresent = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** The six operator-local variables for a world's inputs. */
export const envOf = (inputs: PackInputs): NodeJS.ProcessEnv => ({
  [ENV_PACKS_DIR]: inputs.packsDir,
  [ENV_TERMS_FILE]: inputs.terms,
  [ENV_OWNERS_FILE]: inputs.owners,
  [ENV_INDEX_KEY_FILE]: inputs.indexKey,
  [ENV_STORE_DIR]: inputs.storeDir,
  [ENV_PROJECTS_DIR]: inputs.projectsDir,
});
