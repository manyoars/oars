import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signInsFile } from '../../cli/src/sessions/pool-replica.js';
import { type RunDeps } from '../../cli/src/cli.js';
import { poolDeposit } from '../../cli/src/sessions/pool-command.js';
import { main } from './deposit-fleet.js';
import { CLEAN, makeFake } from './fake-harness.js';
import { arrayAt, objectAt, parseJson, stringAt, type JsonObject } from './json.js';
import { parseOrder } from './order.js';
import { runOrder } from './runner.js';
import { serializeRunBook, type RunBook } from './runbook.js';
import { signRunBook } from './sign.js';
import { buildStores, folderOf, makeStager, type StoreFolder } from './stores.js';
import { FLEET, retestText, taskSet } from './test-fixtures.js';

const IDENTITY = 'run-book@test.invalid';
const KEY_ENV = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';

let root = '';
let fakeHome = '';
const saved = { APPDATA: process.env.APPDATA, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FAKE_OARS_LOG: process.env.FAKE_OARS_LOG, FAKE_OARS_FAIL: process.env.FAKE_OARS_FAIL, FAKE_OARS_FAIL_AT: process.env.FAKE_OARS_FAIL_AT };

// The parent's config variables point at an empty temp folder: a deposit that reached for them would write there, and a test sees it. No test runs the real `oars`.
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet-deposit-'));
  fakeHome = join(root, 'home');
  await mkdir(fakeHome);
  for (const name of ['APPDATA', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) process.env[name] = fakeHome;
  process.env.FAKE_OARS_LOG = join(root, 'fake-oars.log');
  Reflect.deleteProperty(process.env, 'FAKE_OARS_FAIL');
  Reflect.deleteProperty(process.env, 'FAKE_OARS_FAIL_AT');
  console.log(`parent ${KEY_ENV} for this test: ${fakeHome}; temp root: ${root}`);
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const stepClock = (): (() => Date) => {
  let ticks = 0;
  return () => new Date(Date.UTC(2026, 10, 16, 12, 0, ticks++));
};

/** A stand-in for `oars` that records its arguments and the variables that matter, and exits 7 when FAKE_OARS_FAIL names a part of its config root. */
const FAKE_OARS = `import { appendFileSync } from 'node:fs';
const env = process.env;
appendFileSync(env.FAKE_OARS_LOG, JSON.stringify({ args: process.argv.slice(2), appdata: env.APPDATA ?? null, xdg: env.XDG_CONFIG_HOME ?? null, claude: env.CLAUDE_CONFIG_DIR ?? null, terms: env.OARS_EXCLUSION_TERMS ?? null, hostClass: env.OARS_HOST_CLASS ?? null }) + String.fromCharCode(10));
const where = env.${KEY_ENV} ?? '';
const step = process.argv.slice(2);
const armed = env.FAKE_OARS_FAIL !== undefined || env.FAKE_OARS_FAIL_AT !== undefined;
const here = env.FAKE_OARS_FAIL === undefined || where.includes(env.FAKE_OARS_FAIL);
const named = env.FAKE_OARS_FAIL_AT === undefined || step.includes(env.FAKE_OARS_FAIL_AT);
process.exit(armed && here && named ? 7 : 0);
`;

interface Scene {
  runBook: string;
  allowed: string;
  oars: string;
  folders: StoreFolder[];
  book: RunBook;
}

const makeKey = (dir: string): string => {
  const key = join(dir, 'key');
  const made = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', IDENTITY, '-f', key], { encoding: 'utf8' });
  if (made.error !== undefined) throw new Error(`ssh-keygen is required to run this test and was not found on PATH: ${made.error.message}`);
  if (made.status !== 0) throw new Error(`ssh-keygen could not make a key: ${made.stderr}`);
  return key;
};

/** A complete, signed run book, its two store folders with the owner's one-time files in place, and the fake `oars`. */
const scene = async (patch: { runCap?: number; repeats?: number; outName?: string } = {}): Promise<Scene> => {
  const out = join(root, patch.outName ?? 'out');
  const order = parseOrder(retestText({ repeats: patch.repeats ?? 3, runCap: patch.runCap ?? 80 }), FLEET);
  const stager = makeStager(join(root, 'staging'));
  const book = await runOrder({ order, taskSet: taskSet(8), fleet: FLEET, adapter: makeFake(CLEAN), clock: stepClock(), operator: 'Many Oars Co.', stage: stager.stage });
  const folders = await buildStores(book, stager, out);
  const runBook = join(out, 'o-1.run-book.jsonl');
  await writeFile(runBook, serializeRunBook(book));
  const key = makeKey(root);
  if (book.header.status === 'complete') await signRunBook(runBook, key);
  const [type, material] = (await readFile(`${key}.pub`, 'utf8')).trim().split(' ');
  const allowed = join(root, 'allowed_signers');
  await writeFile(allowed, `${IDENTITY} namespaces="manyoars-runbook" ${type ?? ''} ${material ?? ''}\n`);
  for (const folder of folders) {
    await mkdir(folder.storeDir, { recursive: true });
    await writeFile(signInsFile(folder.storeDir), '[]');
    await mkdir(join(folder.configRoot, 'claude', 'session-commons'), { recursive: true });
    await writeFile(join(folder.configRoot, 'claude', 'session-commons', 'exclusion-terms.txt'), 'zorblax\n');
  }
  const oars = join(root, 'fake-oars.mjs');
  await writeFile(oars, FAKE_OARS);
  return { runBook, allowed, oars, folders, book };
};

const NEWEST_END = (book: RunBook): number => Math.max(...book.runs.map((run) => Date.parse(run.end)));
const HOUR = 3_600_000;
/** A `.mjs` --oars runs under this node, so the printed line says so. */
const SHELL_QUOTED = (part: string): string => (part.includes(' ') ? `"${part}"` : part);
const NODE = `${SHELL_QUOTED(process.execPath)} `;
const STEPS = [['pool', 'deposit'], ['pool', 'outbox'], ['pool', 'deposit', '--send-all']];

const run = async (s: Scene, extra: string[], now: Date): Promise<{ code: number; lines: string[] }> => {
  const lines: string[] = [];
  const code = await main([s.runBook, '--allowed-signers', s.allowed, '--identity', IDENTITY, '--oars', s.oars, ...extra], (line) => lines.push(line), () => now);
  return { code, lines };
};

const records = (text: string): JsonObject[] => text.split(String.fromCharCode(10)).filter((line) => line !== '').map((line) => objectAt(parseJson(line, 'line'), 'line'));

const logged = async (): Promise<JsonObject[]> => records(await readFile(process.env.FAKE_OARS_LOG ?? '', 'utf8').catch(() => ''));

describe('deposit-fleet', () => {
  it('prints each store, its config root, its expected sessions, and its three command lines, and runs nothing', async () => {
    const s = await scene();
    const { code, lines } = await run(s, [], new Date(NEWEST_END(s.book) + 7 * HOUR));
    expect(code).toBe(0);
    for (const folder of s.folders) {
      const expected = s.book.runs.filter((entry) => entry.void === null && entry.side === folder.name.split('-')[0]).map((entry) => entry.poolSessionId ?? '');
      expect(lines).toContain(`store ${folder.name}: config root ${folder.configRoot}`);
      expect(lines).toContain(`  expects ${String(expected.length)} sessions: ${expected.join(' ')}`);
      expect(lines).toContain(`  command 1 (build): ${NODE}${SHELL_QUOTED(s.oars)} pool deposit`);
      expect(lines).toContain(`  command 2 (show): ${NODE}${SHELL_QUOTED(s.oars)} pool outbox`);
      expect(lines).toContain(`  command 3 (send): ${NODE}${SHELL_QUOTED(s.oars)} pool deposit --send-all`);
    }
    expect(lines[0]).toBe('deposit-fleet o-1: dry run (add --confirm to send)');
    console.log(lines.map((line) => line.replaceAll(root, '<tmp>')).join('\n'));
    expect(await logged()).toEqual([]);
    expect(await readFile(`${s.runBook.replace('.run-book.jsonl', '')}.deposit-record.jsonl`, 'utf8').catch(() => null)).toBeNull();
  });

  it('quotes a config root with a space on the dry run environment line, so the line can be pasted', async () => {
    const s = await scene({ outName: 'out dir' });
    const { lines } = await run(s, [], new Date(NEWEST_END(s.book) + 7 * HOUR));
    for (const folder of s.folders) {
      expect(folder.configRoot).toContain(' ');
      expect(lines).toContain(`  environment: ${KEY_ENV}="${folder.configRoot}" CLAUDE_CONFIG_DIR="${join(folder.configRoot, 'claude')}"`);
    }
  });

  it('with --confirm runs build, outbox, and send per store with its own config root, records each, and leaves the run book and the parent environment as they were', async () => {
    const s = await scene();
    const before = await readFile(s.runBook, 'utf8');
    const parent = process.env[KEY_ENV];
    process.env.OARS_HOST_CLASS = 'machine';
    const { code, lines } = await run(s, ['--confirm'], new Date(NEWEST_END(s.book) + 7 * HOUR));
    Reflect.deleteProperty(process.env, 'OARS_HOST_CLASS');
    expect(code).toBe(0);
    const calls = await logged();
    expect(calls).toHaveLength(6);
    for (const [index, folder] of s.folders.entries()) {
      for (const [step, args] of STEPS.entries()) {
        const call = calls[index * 3 + step];
        expect(call?.args).toEqual(args);
        expect(process.platform === 'win32' ? call?.appdata : call?.xdg).toBe(folder.configRoot);
        expect(call?.claude).toBe(join(folder.configRoot, 'claude'));
        expect(call?.terms).toBeNull();
        expect(call?.hostClass).toBeNull();
      }
    }
    expect(process.env[KEY_ENV]).toBe(parent);
    expect(process.env[KEY_ENV]).toBe(fakeHome);
    expect(await readFile(s.runBook, 'utf8')).toBe(before);
    const record = records(await readFile(join(join(s.runBook, '..'), 'o-1.deposit-record.jsonl'), 'utf8'));
    expect(record.map((entry) => [entry.store, entry.exitCodes, arrayAt(entry, 'expected', 'record').length])).toEqual([['before-playwright', [0, 0, 0], 24], ['after-playwright', [0, 0, 0], 24]]);
    expect(record[0]?.time).toBe(new Date(NEWEST_END(s.book) + 7 * HOUR).toISOString());
    expect(lines.at(-1)).toBe('deposited 2 of 2 stores');
  });

  it('records a failing store and still runs the others, then exits non-zero', async () => {
    const s = await scene();
    process.env.FAKE_OARS_FAIL = 'before-playwright';
    const { code, lines } = await run(s, ['--confirm'], new Date(NEWEST_END(s.book) + 7 * HOUR));
    expect(code).toBe(1);
    // The failing store stops at its first command; the other store runs all three.
    expect((await logged()).map((call) => call.args)).toEqual([STEPS[0], ...STEPS]);
    const record = records(await readFile(join(join(s.runBook, '..'), 'o-1.deposit-record.jsonl'), 'utf8'));
    expect(record.map((entry) => [entry.store, entry.exitCodes])).toEqual([['before-playwright', [7]], ['after-playwright', [0, 0, 0]]]);
    expect(lines.at(-1)).toBe('deposited 1 of 2 stores; failed: before-playwright (exit 7)');
  });

  it('stops a store at the first non-zero command, whichever step it is, and names the command to run by hand when the send step fails', async () => {
    const s = await scene();
    process.env.FAKE_OARS_FAIL_AT = 'outbox';
    const outbox = await run(s, ['--confirm'], new Date(NEWEST_END(s.book) + 7 * HOUR));
    expect(outbox.code).toBe(1);
    expect((await logged()).map((call) => call.args)).toEqual([STEPS[0], STEPS[1], STEPS[0], STEPS[1]]);
    await rm(process.env.FAKE_OARS_LOG ?? '');
    process.env.FAKE_OARS_FAIL_AT = '--send-all';
    const send = await run(s, ['--confirm'], new Date(NEWEST_END(s.book) + 7 * HOUR));
    expect(send.code).toBe(1);
    expect((await logged()).map((call) => call.args)).toEqual([...STEPS, ...STEPS]);
    expect(send.lines.join(String.fromCharCode(10))).toContain('if the covenant is not accepted, run oars pool deposit --send <hash> at a terminal');
  });

  it('refuses a run book with no signature, and one changed after it was signed', async () => {
    const s = await scene();
    const now = new Date(NEWEST_END(s.book) + 7 * HOUR);
    await rm(`${s.runBook}.sig`);
    expect((await run(s, ['--confirm'], now)).code).toBe(1);
    await signRunBook(s.runBook, join(root, 'key'));
    await writeFile(s.runBook, `${await readFile(s.runBook, 'utf8')} `);
    const tampered = await run(s, ['--confirm'], now);
    expect(tampered.code).toBe(1);
    expect(tampered.lines.join('\n')).toMatch(/not verified/);
    expect(await logged()).toEqual([]);
  });

  it('refuses a run book whose status is not complete', async () => {
    const s = await scene({ runCap: 5 });
    expect(s.book.header.status).toBe('incomplete');
    const { code, lines } = await run(s, ['--confirm'], new Date(NEWEST_END(s.book) + 7 * HOUR));
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/status is incomplete/);
    expect(await logged()).toEqual([]);
  });

  it('refuses while the newest run ended under 6 hours ago, and prints the earliest time it will run', async () => {
    const s = await scene();
    const { code, lines } = await run(s, ['--confirm'], new Date(NEWEST_END(s.book) + 5 * HOUR));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(`the newest run ended under 6 hours ago; the earliest time deposit-fleet will run is ${new Date(NEWEST_END(s.book) + 6 * HOUR).toISOString()}`);
    expect(await logged()).toEqual([]);
    expect((await run(s, ['--confirm'], new Date(NEWEST_END(s.book) + 6 * HOUR))).code).toBe(0);
  });

  it('refuses a store with no sign-in file or no exclusion-terms file, naming the file', async () => {
    const s = await scene();
    const now = new Date(NEWEST_END(s.book) + 7 * HOUR);
    const login = signInsFile(s.folders[1]?.storeDir ?? '');
    await rm(login);
    const noLogin = await run(s, ['--confirm'], now);
    expect(noLogin.code).toBe(1);
    expect(noLogin.lines.join('\n')).toContain(`no sign-in file: ${login} (run oars pool login with this config root)`);
    await writeFile(login, '{}');
    const terms = join(s.folders[0]?.configRoot ?? '', 'claude', 'session-commons', 'exclusion-terms.txt');
    await rm(terms);
    const noTerms = await run(s, ['--confirm'], now);
    expect(noTerms.code).toBe(1);
    expect(noTerms.lines.join('\n')).toContain(`no exclusion-terms file: ${terms}`);
    // Nothing ran for any store, not even the one that was ready.
    expect(await logged()).toEqual([]);
  });

  it('exits 2 with usage when --oars or the run book is missing', async () => {
    const lines: string[] = [];
    expect(await main([], (line) => lines.push(line), () => new Date())).toBe(2);
    expect(await main(['book.jsonl', '--allowed-signers', 'a'], (line) => lines.push(line), () => new Date())).toBe(2);
    expect(lines.join('\n')).toMatch(/usage: deposit-fleet/);
  });
});

describe('the run book row id and the CLI deposit path', () => {
  it('gives each batch the id the run book recorded: poolDeposit builds under contentHash of the account and the session', async () => {
    const s = await scene();
    const [folder] = s.folders;
    if (folder === undefined) throw new Error('no store folder');
    const server = 'https://pool.test';
    const termsFile = join(folder.configRoot, 'claude', 'session-commons', 'exclusion-terms.txt');
    // A signed-in fake account and an unexpired sign-in file in this store only; the build reads it and sends nothing.
    const signIn = [{ server, account: 'acct-fleet', token: 'fake-token', expiresAt: Date.UTC(2030, 0, 1), signingKey: { kty: 'OKP', crv: 'Ed25519', x: 'a-pinned-key' } }];
    await writeFile(signInsFile(folder.storeDir), JSON.stringify(signIn));
    console.log(`store under test: ${folder.storeDir}`);
    // The CLI counts a session as ended 6 hours after its file's last write, and the copied files were written just now.
    const now = Date.now() + 7 * HOUR;
    const deps: RunDeps = {
      env: { OARS_POOL_URL: server, OARS_EXCLUSION_TERMS: termsFile },
      io: { stdout: () => undefined, stderr: () => undefined },
      store: { read: () => Promise.resolve(undefined), write: () => Promise.resolve(), delete: () => Promise.resolve() },
      version: '0.0.0',
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      now: () => now,
      openBrowser: () => Promise.resolve(),
      sessions: { storeDir: folder.storeDir, projectsRoot: folder.projectsRoot, stdin: process.stdin, stdout: { write: () => true } },
    };
    await poolDeposit(deps, { server });
    const outbox = join(folder.storeDir, 'pool-outbox');
    const batchIds = readdirSync(outbox, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => parseJson(readFileSync(join(outbox, name), 'utf8'), name))
      .map((batch) => stringAt(objectAt(batch, 'batch'), 'id', 'batch'));
    const expected = s.book.runs.filter((run) => run.void === null && folderOf(run.side, run.arm) === folder.name).map((run) => run.poolSessionId ?? '');
    expect(expected).toHaveLength(24);
    expect(batchIds.sort()).toEqual(expected.sort());
  });
});
