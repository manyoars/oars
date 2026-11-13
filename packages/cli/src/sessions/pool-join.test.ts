import { webcrypto } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfigDir } from '../credentials.js';
import { spoolEvents } from '../telemetry/read-events.js';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, server, useServer, type Harness } from '../test-support.js';
import { crewNumberOf } from './crew-mark.js';
import { FIELD_ROWS } from './pool-outbox.js';
import { VOCAB_VERSION, type PinnedKey } from './pool-wire.js';
import { deposit } from './store.js';
import { cleanup, NOW, settledClock, stage, TEST_FLOOR, type Staged } from './test-support.js';

useServer();
afterEach(cleanup);

// The store of every test is a folder of its own under the OS temp folder, and APPDATA (where the default store lives on Windows) is pointed at another, so nothing here can reach a real store.
beforeEach(() => {
  const appData = mkdtempSync(join(tmpdir(), 'oars-join-appdata-'));
  vi.stubEnv('APPDATA', appData);
  vi.stubEnv('XDG_CONFIG_HOME', appData);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const POOL = 'https://pool.test';
const LATER = Date.parse('2099-01-01T00:00:00Z');
const VERSION = '2.1.314';

interface Scene {
  h: Harness;
  staged: Staged;
  /** Every request the pool saw, in order, as `METHOD /path`. */
  calls: string[];
  /** What the command had printed to stderr when each request arrived. */
  errAt: string[];
  sign: (text: string) => Promise<string>;
  pinned: PinnedKey;
  cli: (...args: string[]) => Promise<ExitCode>;
}

const keyPair = async (): Promise<{ pinned: PinnedKey; sign: (text: string) => Promise<string> }> => {
  const pair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('no key pair');
  const { x } = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    pinned: { kty: 'OKP', crv: 'Ed25519', x: x ?? '' },
    sign: async (text) => Buffer.from(await webcrypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(text))).toString('base64'),
  };
};

interface Routes {
  /** The answers to successive deposits; the last stands. */
  deposits?: Response[];
  /** The answers to successive bundle fetches; the last stands. */
  bundles?: (() => Promise<Response>)[];
  covenant?: Response;
  /** False leaves the exclusion term file out, so the person has none. */
  terms?: boolean;
}

/** A fake pool with the device flow answered at once, the covenant already accepted, and every route recording its request. */
const scene = async (routes: Routes = {}): Promise<Scene> => {
  const staged = stage();
  const termsFile = join(staged.root, 'terms.txt');
  if (routes.terms !== false) writeFileSync(termsFile, 'zorblax\n');
  const h = harness({ OARS_EXCLUSION_TERMS: termsFile });
  h.deps.sessions = staged.runtime;
  h.deps.now = settledClock;
  const { pinned, sign } = await keyPair();
  const calls: string[] = [];
  const errAt: string[] = [];
  const note = (request: Request): void => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    errAt.push(h.err.join(''));
  };
  const after = <T>(list: T[], at: number): T | undefined => list[Math.min(at, list.length - 1)];
  const taken = { deposit: 0, bundle: 0 };
  const payload = JSON.stringify({ format: 1, harness: 'claude-code', harnessVersion: VERSION, vocabVersion: VOCAB_VERSION, floor: TEST_FLOOR, asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: [{}, {}], strata: [] });
  const signature = await sign(payload);
  const deposits = routes.deposits ?? [new HttpResponse(JSON.stringify({ ok: true }), { status: 201, headers: { 'content-type': 'application/json' } })];
  const bundles = routes.bundles ?? [() => Promise.resolve(HttpResponse.json({ payload, signature }))];
  server.use(
    http.post(`${POOL}/v1/login/start`, ({ request }) => {
      note(request);
      return HttpResponse.json({ handle: 'a-handle', userCode: 'USER-1', verificationUrl: 'https://provider.test/device', interval: 2, expiresIn: 10 });
    }),
    http.post(`${POOL}/v1/login/poll`, ({ request }) => {
      note(request);
      return HttpResponse.json({ status: 'authorized', token: 'a-pool-token', account: 'acct_one', expiresAt: LATER, signingKey: pinned });
    }),
    http.get(`${POOL}/v1/covenant`, ({ request }) => {
      note(request);
      return routes.covenant ?? HttpResponse.json({ version: 'v1', accepted: true });
    }),
    http.post(`${POOL}/v1/deposits`, ({ request }) => {
      note(request);
      const next = after(deposits, taken.deposit);
      taken.deposit += 1;
      return (next ?? new HttpResponse(null, { status: 500 })).clone();
    }),
    http.get(`${POOL}/bundle/:harness/:version/:vocab`, async ({ request }) => {
      note(request);
      const next = after(bundles, taken.bundle);
      taken.bundle += 1;
      return next === undefined ? new HttpResponse(null, { status: 500 }) : next();
    }),
  );
  return { h, staged, calls, errAt, sign, pinned, cli: (...args) => run(args, h.deps) };
};

const capture = (s: Scene): Promise<unknown> => deposit(s.staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });

const joinArgs = ['pool', 'join', '--provider', 'github', '--harness', 'claude-code', '--harness-version', VERSION, '--server', POOL];

const out = (s: Scene): string => s.h.out.join('');
const err = (s: Scene): string => s.h.err.join('');
const outboxFiles = (s: Scene): string[] => {
  const root = join(s.staged.storeDir, 'pool-outbox');
  return existsSync(root) ? readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.jsonl')) : [];
};
const sentLogs = (s: Scene): string => {
  const root = join(s.staged.storeDir, 'pool-outbox');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('sent.log'))
    .map((name) => readFileSync(join(root, name), 'utf8'))
    .join('');
};
const count = (s: Scene, call: string): number => s.calls.filter((made) => made === call).length;

/** The `invite` field of the join's JSON document. */
const inviteOf = (printed: string): unknown => {
  const document: unknown = JSON.parse(printed);
  return typeof document === 'object' && document !== null ? Reflect.get(document, 'invite') : undefined;
};

const AGAIN = 'Run oars pool join again to continue from here.';

describe('oars pool join', () => {
  it('takes a first-time person from nothing to a sent deposit and a fetched bundle, in the order of the five commands', async () => {
    const s = await scene();
    await capture(s);
    expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
    // The fixture store holds several sessions, so several batches: each is sent the way `deposit --send <hash>` sends one (the covenant read, then the post).
    const batches = outboxFiles(s).length;
    expect(batches).toBeGreaterThan(1);
    expect(s.calls).toEqual(['POST /v1/login/start', 'POST /v1/login/poll', 'GET /v1/covenant', ...Array.from({ length: batches }, () => ['GET /v1/covenant', 'POST /v1/deposits']).flat(), `GET /bundle/claude-code/${VERSION}/${VOCAB_VERSION}`]);
    // One plain line per step, in order, each before the work of its step.
    const lines = err(s).split('\n');
    const at = (text: string): number => lines.findIndex((line) => line.includes(text));
    expect(at('Signing in to https://pool.test')).toBeGreaterThanOrEqual(0);
    expect(at('Signing in')).toBeLessThan(at('Preparing'));
    expect(at('Preparing')).toBeLessThan(at('Showing what will be sent'));
    expect(at('Showing what will be sent')).toBeLessThan(at('batches to https://pool.test'));
    expect(at('batches to https://pool.test')).toBeLessThan(at('Fetching the bundle for claude-code'));
    expect(sentLogs(s)).toMatch(/^[0-9a-f]{64} /);
    expect(out(s)).toContain('Signed in to https://pool.test as acct_one.');
    expect(out(s)).toContain('Fetched claude-code 2.1.314: 2 reads');
  });

  it('prints what outbox --explain prints, every field with its rule, before anything is sent', async () => {
    const s = await scene();
    await capture(s);
    expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
    const printed = out(s);
    expect(printed).toMatch(/^sha256: [0-9a-f]{64}$/m);
    const [field] = Object.keys(FIELD_ROWS);
    expect(printed).toContain(`  ${field ?? ''}: ${FIELD_ROWS[field ?? ''] ?? ''}`);
    // The explanation was already on stdout when the deposit request arrived.
    const sentAt = s.calls.indexOf('POST /v1/deposits');
    expect(s.errAt[sentAt]).toContain('Showing what will be sent');
    // The batch printed is the batch sent: `outbox` records it as shown, which is what lets the send pass.
    const hash = /^sha256: ([0-9a-f]{64})$/m.exec(printed)?.[1] ?? '';
    expect(sentLogs(s)).toContain(hash);
  });

  it('asks the covenant question the deposit --send asks: off a terminal an unaccepted covenant stops it, and nothing is sent', async () => {
    const s = await scene({ covenant: HttpResponse.json({ version: 'v1', accepted: false, screen: { text: 'COVENANT', link: 'https://pool.test/c', phrase: 'I AGREE', sha256: 'a'.repeat(64) } }) });
    await capture(s);
    expect(await s.cli(...joinArgs)).toBe(ExitCode.AUTH);
    expect(err(s)).toContain('is not accepted for this account');
    expect(count(s, 'POST /v1/deposits')).toBe(0);
    expect(err(s)).toContain(AGAIN);
  });

  describe('a step that fails stops the command with its own error and one line naming the command to run again', () => {
    it('login', async () => {
      const s = await scene();
      await capture(s);
      server.use(http.post(`${POOL}/v1/login/start`, () => HttpResponse.json({ error: 'provider_down', message: 'The provider is down.' }, { status: 503 })));
      expect(await s.cli(...joinArgs)).not.toBe(ExitCode.OK);
      expect(err(s)).toContain('The provider is down.');
      expect(err(s)).toContain(AGAIN);
      expect(s.calls).toEqual([]);
      expect(outboxFiles(s)).toEqual([]);
    });

    it('send: the pool refuses the deposit, and no fetch is made', async () => {
      const s = await scene({ deposits: [HttpResponse.json({ error: 'rate_limited', message: 'Slow down.' }, { status: 429 })] });
      await capture(s);
      expect(await s.cli(...joinArgs)).not.toBe(ExitCode.OK);
      expect(err(s)).toContain('Slow down.');
      expect(err(s)).toContain(AGAIN);
      expect(count(s, `GET /bundle/claude-code/${VERSION}/${VOCAB_VERSION}`)).toBe(0);
      expect(sentLogs(s)).toBe('');
    });

    it('fetch: the deposit stands, and the line names the command', async () => {
      const s = await scene({ bundles: [() => Promise.resolve(new HttpResponse(null, { status: 500 }))] });
      await capture(s);
      expect(await s.cli(...joinArgs)).not.toBe(ExitCode.OK);
      expect(err(s)).toContain('The pool answered HTTP 500');
      expect(err(s)).toContain(AGAIN);
      expect(sentLogs(s)).toMatch(/^[0-9a-f]{64} /);
    });

    it('says the line once', async () => {
      const s = await scene({ deposits: [HttpResponse.json({ error: 'rate_limited', message: 'Slow down.' }, { status: 429 })] });
      await capture(s);
      await s.cli(...joinArgs);
      expect(err(s).split('\n').filter((line) => line === AGAIN)).toHaveLength(1);
    });
  });

  describe('running it again picks up where it stopped', () => {
    it('does not send a signed-in person through login', async () => {
      const s = await scene();
      await capture(s);
      expect(await s.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
      s.calls.length = 0;
      s.h.err.length = 0;
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      expect(count(s, 'POST /v1/login/start')).toBe(0);
      expect(err(s)).toContain('Already signed in to https://pool.test');
      expect(count(s, 'POST /v1/deposits')).toBe(outboxFiles(s).length);
    });

    it('does not prepare an outbox that already holds an unsent batch', async () => {
      const s = await scene();
      await capture(s);
      expect(await s.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
      expect(await s.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
      const before = outboxFiles(s);
      s.h.out.length = 0;
      s.h.err.length = 0;
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      expect(outboxFiles(s)).toEqual(before);
      expect(err(s)).toContain('already holds a prepared batch');
      expect(out(s)).not.toContain('sessions to the outbox');
    });

    it('does not send a deposit already sent: a join stopped at fetch is finished by a second run with one deposit in all', async () => {
      const s = await scene({ bundles: [() => Promise.resolve(new HttpResponse(null, { status: 500 }))] });
      await capture(s);
      expect(await s.cli(...joinArgs)).not.toBe(ExitCode.OK);
      const batches = outboxFiles(s).length;
      expect(batches).toBeGreaterThan(0);
      expect(count(s, 'POST /v1/deposits')).toBe(batches);
      // The pool now serves the bundle.
      const payload = JSON.stringify({ format: 1, harness: 'claude-code', harnessVersion: VERSION, vocabVersion: VOCAB_VERSION, floor: TEST_FLOOR, asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: [{}, {}], strata: [] });
      const signature = await s.sign(payload);
      server.use(http.get(`${POOL}/bundle/:harness/:version/:vocab`, () => HttpResponse.json({ payload, signature })));
      s.h.out.length = 0;
      s.h.err.length = 0;
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      expect(count(s, 'POST /v1/deposits')).toBe(batches);
      expect(count(s, 'POST /v1/login/start')).toBe(1);
      expect(err(s)).toContain('Everything prepared is already sent');
      expect(out(s)).toContain('Fetched claude-code 2.1.314');
    });
  });

  it('with no session ready sends nothing, says so, and still fetches', async () => {
    const s = await scene();
    expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
    expect(count(s, 'POST /v1/deposits')).toBe(0);
    expect(err(s)).toContain('No session is ready to deposit yet; sending nothing.');
    expect(out(s)).toContain('Fetched claude-code 2.1.314');
  });

  it('with --json prints one document and no step text', async () => {
    const s = await scene();
    await capture(s);
    expect(await s.cli(...joinArgs, '--json')).toBe(ExitCode.OK);
    expect(s.h.out).toHaveLength(1);
    expect(JSON.parse(out(s))).toMatchObject({ ok: true, server: POOL, fetch: { ok: true, harnessVersion: VERSION } });
  });

  it('with --json the explanation is on screen (stderr) before the first send, and stdout stays one document', async () => {
    const s = await scene();
    await capture(s);
    expect(await s.cli(...joinArgs, '--json')).toBe(ExitCode.OK);
    const sentAt = s.calls.indexOf('POST /v1/deposits');
    expect(s.errAt[sentAt]).toContain('sha256: ');
    expect(s.h.out).toHaveLength(1);
    expect(sentLogs(s)).toMatch(/^[0-9a-f]{64} /);
  });

  describe('the outbox prints batch by batch, never as one string (a large outbox passed the V8 string limit)', () => {
    const prepared = async (): Promise<Scene> => {
      const s = await scene();
      await capture(s);
      expect(await s.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
      expect(await s.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
      s.h.out.length = 0;
      return s;
    };
    const hashes = (chunk: string): number => (chunk.match(/^sha256: [0-9a-f]{64}$/gm) ?? []).length;

    it.each([['outbox', []], ['outbox --explain', ['--explain']]])('%s writes each batch on its own', async (_name, extra) => {
      const s = await prepared();
      expect(await s.cli('pool', 'outbox', ...extra, '--server', POOL)).toBe(ExitCode.OK);
      expect(s.h.out.length).toBeGreaterThan(1);
      for (const chunk of s.h.out) expect(hashes(chunk)).toBeLessThanOrEqual(1);
      expect(hashes(out(s))).toBe(outboxFiles(s).length);
      expect(out(s).endsWith('\n')).toBe(true);
    });

    it('records each printed batch as shown, so the send that follows passes', async () => {
      const s = await prepared();
      expect(await s.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
      const hash = /^sha256: ([0-9a-f]{64})$/m.exec(out(s))?.[1] ?? '';
      expect(await s.cli('pool', 'deposit', '--send', hash, '--server', POOL)).toBe(ExitCode.OK);
    });

    it('--json is one write while the document fits in a string, and pieces that parse as the same document once it does not', async () => {
      const s = await prepared();
      expect(await s.cli('pool', 'outbox', '--json', '--server', POOL)).toBe(ExitCode.OK);
      expect(s.h.out).toHaveLength(1);
      const whole = out(s);
      s.h.out.length = 0;
      // V8 throws RangeError for a string past its length; here the same error is raised for the whole document, which is what a large outbox does.
      const real = JSON.stringify.bind(JSON);
      const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
        if (typeof value === 'object' && value !== null && 'batches' in value && 'raw' in value) throw new RangeError('Invalid string length');
        return real(value);
      });
      try {
        expect(await s.cli('pool', 'outbox', '--json', '--server', POOL)).toBe(ExitCode.OK);
      } finally {
        spy.mockRestore();
      }
      expect(s.h.out.length).toBeGreaterThan(1);
      for (const piece of s.h.out) expect(piece.length).toBeLessThan(whole.length);
      expect(out(s)).toBe(whole);
    });

    it('an empty outbox still says so', async () => {
      const s = await scene();
      expect(await s.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
      s.h.out.length = 0;
      expect(await s.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
      expect(out(s)).toBe('The outbox is empty. Run oars pool deposit first.\n');
    });
  });

  describe('help', () => {
    it('oars pool --help lists join in a short sentence', async () => {
      const s = await scene();
      expect(await s.cli('pool', '--help')).toBe(ExitCode.OK);
      expect(out(s).replace(/\s+/g, ' ')).toContain('join [options] your first deposit in one command');
    });

    it('oars pool join --help describes it in one or two short sentences and takes the flags the five commands take', async () => {
      const s = await scene();
      expect(await s.cli('pool', 'join', '--help')).toBe(ExitCode.OK);
      const help = out(s);
      expect(help).toContain('your first deposit in one command');
      for (const option of ['--provider', '--plan', '--harness-version', '--harness', '--accept-covenant', '--in-eu-eea-uk', '--verbose', '--server']) expect(help).toContain(option);
    });
  });
});

/** Makes the run a terminal and types each line into it. */
const atTerminal = (s: Scene, ...lines: string[]): void => {
  Object.assign(s.staged.stdin, { isTTY: true });
  Object.assign(s.staged.runtime, { stderr: { isTTY: true } });
  for (const line of lines) s.staged.stdin.write(`${line}\n`);
};

const termsPath = (s: Scene): string => s.h.deps.env.OARS_EXCLUSION_TERMS ?? '';

/** Telemetry into a folder under the scene's own root; the events it kept for a type. */
const watching = (s: Scene): ((type: string) => { data: { [field: string]: unknown } }[]) => {
  s.h.deps.env.APPDATA = s.staged.root;
  expect(defaultConfigDir(s.h.deps.env, 'win32', 'C:\\unused-home')).toBe(s.staged.root);
  const dir = join(s.staged.root, 'oars', 'telemetry');
  s.h.deps.telemetry = { dir, platform: 'linux' };
  return (type) => spoolEvents(dir, type);
};

const SCREEN_TEXT = 'FIXTURE COVENANT v1\n\nTo accept, type: I AGREE';
const SCREEN = { text: SCREEN_TEXT, link: 'https://pool.test/c', phrase: 'I AGREE', sha256: 'a'.repeat(64) };

/** A pool whose covenant is open for acceptance until a typed acceptance arrives; it records each acceptance body. */
const unaccepted = (): { covenant: () => Response; bodies: object[] } => {
  const state: { accepted: boolean; bodies: object[] } = { accepted: false, bodies: [] };
  server.use(
    http.post(`${POOL}/v1/covenant/accept`, async ({ request }) => {
      const body: unknown = await request.json();
      if (typeof body === 'object' && body !== null) state.bodies.push(body);
      state.accepted = true;
      return HttpResponse.json({ ok: true, version: 'v1' });
    }),
  );
  return { covenant: () => HttpResponse.json({ version: 'v1', accepted: state.accepted, screen: SCREEN }), bodies: state.bodies };
};

const STEPS = ['signin', 'region', 'terms', 'batch', 'outbox', 'covenant', 'send', 'raw'];
const STATES = ['done', 'pending'];

const record = (value: unknown): { [key: string]: unknown } => {
  if (typeof value !== 'object' || value === null) throw new Error('not an object');
  return Object.fromEntries(Object.entries(value));
};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** The steps of a plan document, each as its record. */
const stepsOf = (s: Scene): { [key: string]: unknown }[] => list(record(JSON.parse(out(s))).steps).map(record);

/** The shape of the plan document, checked key by key: nothing else may appear in it. */
const planShape = (s: Scene, flagged = false): void => {
  const doc = record(JSON.parse(out(s)));
  expect(Object.keys(doc).sort()).toEqual(['ok', 'plan', 'server', 'steps']);
  expect(doc.ok).toBe(true);
  expect(doc.plan).toBe(true);
  expect(typeof doc.server).toBe('string');
  const steps = stepsOf(s);
  expect(steps.map((step) => step.step)).toEqual(STEPS);
  for (const step of steps) {
    expect(Object.keys(step).sort()).toEqual(['needs_person', 'state', 'step']);
    expect(STATES).toContain(step.state);
    expect(typeof step.needs_person).toBe('boolean');
  }
  // The covenant phrase and the raw prompt are always a person's; region and terms are too while pending and no flag or file answers them.
  for (const step of steps) {
    const always = step.step === 'covenant' || step.step === 'raw';
    const answerable = (step.step === 'region' || step.step === 'terms') && step.state === 'pending';
    expect(step.needs_person).toBe(always || (answerable && !(step.step === 'region' && flagged)));
  }
};

describe('oars pool join, the first deposit in one command', () => {
  const KILL = new Error('killed');

  describe('the term file', () => {
    it('is scaffolded and asked for, never filled in: a run with no terms stops after sign-in, names the file, and sends nothing', async () => {
      const s = await scene({ terms: false });
      await capture(s);
      expect(existsSync(termsPath(s))).toBe(false);
      expect(await s.cli(...joinArgs)).not.toBe(ExitCode.OK);
      expect(existsSync(termsPath(s))).toBe(true);
      expect(readFileSync(termsPath(s), 'utf8')).toBe('');
      expect(err(s)).toContain(termsPath(s));
      expect(err(s)).toContain(AGAIN);
      expect(count(s, 'POST /v1/deposits')).toBe(0);
      expect(outboxFiles(s)).toEqual([]);
      // Edited, the next run signs in nothing again and goes on.
      writeFileSync(termsPath(s), 'zorblax\n');
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      expect(count(s, 'POST /v1/login/start')).toBe(1);
      expect(count(s, 'POST /v1/deposits')).toBe(outboxFiles(s).length);
    });

    it('at a terminal waits for the person to save the file, then goes on in the same run', async () => {
      const s = await scene({ terms: false });
      await capture(s);
      atTerminal(s, '');
      const write = s.h.deps.io.stderr;
      s.h.deps.io.stderr = (text) => {
        write(text);
        if (text.includes('Press Enter')) writeFileSync(termsPath(s), 'zorblax\n');
      };
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      expect(count(s, 'POST /v1/deposits')).toBe(outboxFiles(s).length);
    });

    it('at a terminal stops when the file is still empty after Enter', async () => {
      const s = await scene({ terms: false });
      await capture(s);
      atTerminal(s, '');
      expect(await s.cli(...joinArgs)).not.toBe(ExitCode.OK);
      expect(err(s)).toContain('still holds no term');
      expect(count(s, 'POST /v1/deposits')).toBe(0);
    });
  });

  describe('the region question', () => {
    it('is asked plainly at its own step, before the covenant screen, and its answer goes with the acceptance', async () => {
      const open = unaccepted();
      const s = await scene();
      server.use(http.get(`${POOL}/v1/covenant`, ({ request }) => {
        s.calls.push(`${request.method} ${new URL(request.url).pathname}`);
        return open.covenant();
      }));
      await capture(s);
      atTerminal(s, 'no', SCREEN.phrase);
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      const text = err(s);
      expect(text.split('Are you in the EU, the EEA, or the UK?')).toHaveLength(2);
      expect(text.indexOf('Are you in the EU, the EEA, or the UK?')).toBeLessThan(text.indexOf('FIXTURE COVENANT v1'));
      expect(open.bodies).toEqual([expect.objectContaining({ version: 'v1', input: 'typed', euEeaUk: 'no' })]);
      expect(count(s, 'POST /v1/deposits')).toBe(outboxFiles(s).length);
    });

    it('is not asked of an account that has accepted, and not asked when the flag answers it', async () => {
      const s = await scene();
      await capture(s);
      atTerminal(s);
      expect(await s.cli(...joinArgs, '--in-eu-eea-uk', 'no')).toBe(ExitCode.OK);
      expect(err(s)).not.toContain('Are you in the EU');
    });

    it('names --in-eu-eea-uk no as the way to correct a wrong yes when the pool refuses the region', async () => {
      const open = unaccepted();
      const s = await scene();
      server.use(http.get(`${POOL}/v1/covenant`, () => open.covenant()));
      server.use(http.post(`${POOL}/v1/covenant/accept`, () => HttpResponse.json({ error: 'region_closed', message: 'Many Oars cannot take deposits from the EU yet.' }, { status: 403 })));
      await capture(s);
      atTerminal(s, 'yes', SCREEN.phrase);
      expect(await s.cli(...joinArgs)).toBe(ExitCode.AUTH);
      expect(err(s)).toContain('--in-eu-eea-uk no');
      expect(err(s)).toContain('cannot take deposits from the EU yet');
    });

    it('does not suggest --in-eu-eea-uk no to someone who already answered no and was refused on the request origin', async () => {
      const open = unaccepted();
      const s = await scene();
      server.use(http.get(`${POOL}/v1/covenant`, () => open.covenant()));
      server.use(http.post(`${POOL}/v1/covenant/accept`, () => HttpResponse.json({ error: 'region_closed', message: 'Many Oars cannot take deposits from the EU yet.' }, { status: 403 })));
      await capture(s);
      atTerminal(s, 'no', SCREEN.phrase);
      expect(await s.cli(...joinArgs)).toBe(ExitCode.AUTH);
      expect(err(s)).not.toContain('--in-eu-eea-uk no');
    });

    it('stops on an answer that is not yes or no, before anything is accepted or sent', async () => {
      const open = unaccepted();
      const s = await scene({ covenant: open.covenant() });
      await capture(s);
      atTerminal(s, 'maybe');
      expect(await s.cli(...joinArgs)).not.toBe(ExitCode.OK);
      expect(open.bodies).toEqual([]);
      expect(count(s, 'POST /v1/deposits')).toBe(0);
    });
  });

  describe('acceptance is a person at a terminal', () => {
    it('refuses off a terminal, with or without --accept-covenant, and exits nonzero with nothing accepted or sent', async () => {
      for (const extra of [[], ['--accept-covenant', 'v1']]) {
        const open = unaccepted();
        const s = await scene({ covenant: open.covenant() });
        await capture(s);
        // The flag only names a version, and off a terminal it is refused as a usage error before the screen: either way nonzero, with nothing accepted.
        expect(await s.cli(...joinArgs, ...extra)).toBe(extra.length === 0 ? ExitCode.AUTH : ExitCode.USAGE);
        expect(open.bodies).toEqual([]);
        expect(count(s, 'POST /v1/deposits')).toBe(0);
      }
    });

    it('takes the typed phrase at a terminal and nothing else', async () => {
      const open = unaccepted();
      const s = await scene();
      server.use(http.get(`${POOL}/v1/covenant`, () => open.covenant()));
      await capture(s);
      atTerminal(s, 'no', 'yes please');
      expect(await s.cli(...joinArgs)).toBe(ExitCode.AUTH);
      expect(open.bodies).toEqual([]);
      expect(count(s, 'POST /v1/deposits')).toBe(0);
    });
  });

  describe('a run killed after a step starts the next one at the first step not done', () => {
    for (const [after, before, ran] of [
      ['signin', 'Preparing your deposit', { login: 1 }],
      ['batch', 'Showing what will be sent', { login: 1 }],
      ['outbox', 'batches to https://pool.test', { login: 1 }],
    ] as const) {
      it(`after ${after}`, async () => {
        const s = await scene();
        await capture(s);
        const write = s.h.deps.io.stderr;
        s.h.deps.io.stderr = (text) => {
          if (text.includes(before)) throw KILL;
          write(text);
        };
        expect(await s.cli(...joinArgs)).toBe(ExitCode.UNEXPECTED);
        expect(err(s)).toContain('killed');
        s.h.deps.io.stderr = write;
        s.h.out.length = 0;
        s.h.err.length = 0;
        expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
        expect(count(s, 'POST /v1/login/start')).toBe(ran.login);
        expect(count(s, 'POST /v1/deposits')).toBe(outboxFiles(s).length);
        if (after !== 'signin') expect(err(s)).toContain('Already signed in');
        if (after === 'batch' || after === 'outbox') expect(err(s)).toContain('already holds a prepared batch');
        // The batches are sent once each across both runs.
        const sent = sentLogs(s).trim().split('\n');
        expect(new Set(sent.map((line) => line.split(' ')[0])).size).toBe(sent.length);
      });
    }
  });

  describe('a run killed after region, terms, or the covenant resumes at the next step', () => {
    const killAt = (s: Scene, text: string): (() => void) => {
      const write = s.h.deps.io.stderr;
      s.h.deps.io.stderr = (line) => {
        if (line.includes(text)) throw KILL;
        write(line);
      };
      return () => {
        s.h.deps.io.stderr = write;
        s.h.out.length = 0;
        s.h.err.length = 0;
      };
    };

    it('after region: the answer is kept, the next run does not ask it again, and --plan reads it as done', async () => {
      const open = unaccepted();
      const s = await scene({ terms: false });
      server.use(http.get(`${POOL}/v1/covenant`, () => open.covenant()));
      await capture(s);
      atTerminal(s, 'no');
      const restore = killAt(s, 'Your exclusion terms go in');
      expect(await s.cli(...joinArgs)).toBe(ExitCode.UNEXPECTED);
      restore();
      writeFileSync(termsPath(s), 'zorblax\n');
      expect(await s.cli('pool', 'join', '--plan', '--json', '--server', POOL)).toBe(ExitCode.OK);
      expect(stepsOf(s).find((step) => step.step === 'region')).toMatchObject({ state: 'done', needs_person: false });
      s.h.out.length = 0;
      atTerminal(s, SCREEN.phrase);
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      expect(err(s)).not.toContain('Are you in the EU');
      expect(open.bodies).toEqual([expect.objectContaining({ euEeaUk: 'no' })]);
    });

    it('after terms: the next run skips region and terms and starts at the batch', async () => {
      const open = unaccepted();
      const s = await scene({ terms: false });
      server.use(http.get(`${POOL}/v1/covenant`, () => open.covenant()));
      const events = watching(s);
      await capture(s);
      atTerminal(s, 'no', '');
      const write = s.h.deps.io.stderr;
      s.h.deps.io.stderr = (text) => {
        if (text.includes('Press Enter')) writeFileSync(termsPath(s), 'zorblax\n');
        if (text.includes('Preparing your deposit')) throw KILL;
        write(text);
      };
      expect(await s.cli(...joinArgs)).toBe(ExitCode.UNEXPECTED);
      s.h.deps.io.stderr = write;
      const before = events('join-step').length;
      atTerminal(s, 'not the phrase');
      expect(await s.cli(...joinArgs)).not.toBe(ExitCode.OK);
      expect(events('join-step').map((event) => `${String(event.data.step)}:${String(event.data.state)}`).slice(before, before + 4)).toEqual(['signin:skipped', 'region:skipped', 'terms:skipped', 'batch:done']);
    });

    it('after the covenant: the next run does not ask or accept again and sends', async () => {
      const open = unaccepted();
      const s = await scene();
      server.use(http.get(`${POOL}/v1/covenant`, () => open.covenant()));
      await capture(s);
      atTerminal(s, 'no', SCREEN.phrase);
      const restore = killAt(s, 'Accepted. Sending your batch now.');
      expect(await s.cli(...joinArgs)).toBe(ExitCode.UNEXPECTED);
      expect(open.bodies).toHaveLength(1);
      restore();
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      expect(open.bodies).toHaveLength(1);
      expect(err(s)).not.toContain('FIXTURE COVENANT');
      expect(err(s)).not.toContain('Are you in the EU');
      expect(count(s, 'POST /v1/deposits')).toBe(outboxFiles(s).length);
    });
  });

  describe('Ctrl-C ends the join at whatever step it is in', () => {
    it('during the sign-in poll ends the run with exit 130 and sends nothing', async () => {
      const s = await scene();
      await capture(s);
      let polls = 0;
      server.use(http.post(`${POOL}/v1/login/poll`, () => {
        polls += 1;
        process.emit('SIGINT');
        return HttpResponse.json({ status: 'pending' });
      }));
      expect(await s.cli(...joinArgs)).toBe(ExitCode.INTERRUPTED);
      expect(polls).toBe(1);
      expect(count(s, 'POST /v1/deposits')).toBe(0);
      expect(err(s)).toContain(AGAIN);
    });
  });

  describe('without --harness-version', () => {
    it('fetches nothing: no bundle request, no fetch line, and no fetch key in the document', async () => {
      const s = await scene();
      await capture(s);
      const args = joinArgs.filter((arg, at) => arg !== '--harness-version' && joinArgs[at - 1] !== '--harness-version');
      expect(await s.cli(...args, '--json')).toBe(ExitCode.OK);
      expect(s.calls.some((call) => call.startsWith('GET /bundle/'))).toBe(false);
      expect(err(s)).not.toContain('Fetching the bundle');
      expect(Object.keys(record(JSON.parse(out(s)))).sort()).toEqual(['deposit', 'invite', 'login', 'ok', 'outbox', 'sends', 'server']);
    });
  });

  describe('--plan --json, the steps a person answers', () => {
    it('marks region and terms needs_person while pending, and not once a flag or the file answers them', async () => {
      const open = unaccepted();
      const s = await scene({ terms: false });
      server.use(http.get(`${POOL}/v1/covenant`, () => open.covenant()));
      await capture(s);
      expect(await s.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
      s.h.out.length = 0;
      expect(await s.cli('pool', 'join', '--plan', '--json', '--server', POOL)).toBe(ExitCode.OK);
      planShape(s);
      expect(stepsOf(s).filter((step) => step.needs_person).map((step) => step.step)).toEqual(['region', 'terms', 'covenant', 'raw']);
      s.h.out.length = 0;
      writeFileSync(termsPath(s), 'zorblax\n');
      expect(await s.cli('pool', 'join', '--plan', '--json', '--in-eu-eea-uk', 'no', '--server', POOL)).toBe(ExitCode.OK);
      planShape(s, true);
      expect(stepsOf(s).filter((step) => step.needs_person).map((step) => step.step)).toEqual(['covenant', 'raw']);
    });
  });

  describe('the join-step event, when there is nothing to deposit', () => {
    it('records covenant and send as none (not skipped) when no session is ready', async () => {
      const s = await scene();
      const events = watching(s);
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      expect(events('join-step').map((event) => `${String(event.data.step)}:${String(event.data.state)}`).slice(-2)).toEqual(['covenant:none', 'send:none']);
    });
  });

  describe('--plan --json', () => {
    it('makes no request and writes nothing for a person who has done nothing, and matches the shape', async () => {
      const s = await scene({ terms: false });
      await capture(s);
      expect(await s.cli('pool', 'join', '--plan', '--json', '--server', POOL)).toBe(ExitCode.OK);
      planShape(s);
      expect(stepsOf(s).every((step) => step.state === 'pending')).toBe(true);
      expect(s.calls).toEqual([]);
      expect(existsSync(termsPath(s))).toBe(false);
      expect(outboxFiles(s)).toEqual([]);
    });

    it('shows each step done after a full join, with the raw question still the person\'s', async () => {
      const s = await scene();
      await capture(s);
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      s.h.out.length = 0;
      s.calls.length = 0;
      expect(await s.cli('pool', 'join', '--plan', '--json', '--server', POOL)).toBe(ExitCode.OK);
      planShape(s);
      expect(stepsOf(s).map((step) => `${String(step.step)}:${String(step.state)}`)).toEqual(['signin:done', 'region:done', 'terms:done', 'batch:done', 'outbox:done', 'covenant:done', 'send:done', 'raw:pending']);
      // The only request is the read of the covenant, which a plan needs to know whether it is accepted.
      expect(s.calls).toEqual(['GET /v1/covenant']);
    });

    it('leaves the covenant and the steps after it pending while the covenant is unaccepted', async () => {
      const open = unaccepted();
      const s = await scene({ covenant: open.covenant() });
      await capture(s);
      expect(await s.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
      s.h.out.length = 0;
      expect(await s.cli('pool', 'join', '--plan', '--json', '--server', POOL)).toBe(ExitCode.OK);
      expect(stepsOf(s).filter((step) => step.state === 'pending').map((step) => step.step)).toEqual(['region', 'batch', 'outbox', 'covenant', 'send', 'raw']);
    });
  });

  describe('the join-step event', () => {
    it('carries only the closed step and state words, one per step run, and "skipped" for a step a second run finds done', async () => {
      const s = await scene();
      const events = watching(s);
      await capture(s);
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      const first = events('join-step').map((event) => event.data);
      for (const data of first) expect(Object.keys(data).sort()).toEqual(['state', 'step']);
      expect(first).toEqual([
        { step: 'signin', state: 'done' },
        { step: 'region', state: 'skipped' },
        { step: 'terms', state: 'skipped' },
        { step: 'batch', state: 'done' },
        { step: 'outbox', state: 'done' },
        { step: 'covenant', state: 'skipped' },
        { step: 'send', state: 'done' },
      ]);
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      const second = events('join-step').map((event) => event.data).slice(first.length);
      expect(second.map((data) => `${String(data.step)}:${String(data.state)}`)).toEqual(['signin:skipped', 'region:skipped', 'terms:skipped', 'batch:done', 'outbox:done', 'covenant:skipped', 'send:skipped']);
    });

    it('records the step that stopped the run as stopped', async () => {
      const s = await scene({ terms: false });
      const events = watching(s);
      await capture(s);
      await s.cli(...joinArgs);
      expect(events('join-step').map((event) => event.data)).toEqual([
        { step: 'signin', state: 'done' },
        { step: 'region', state: 'skipped' },
        { step: 'terms', state: 'stopped' },
      ]);
    });
  });

  describe('--invite', () => {
    it('redeems the code once after sign-in, with the token, before anything is prepared, and reports it', async () => {
      const s = await scene();
      const seen: Array<{ auth: string | null; body: unknown }> = [];
      server.use(http.post(`${POOL}/v1/invites/redeem`, async ({ request }) => { s.calls.push('POST /v1/invites/redeem'); seen.push({ auth: request.headers.get('authorization'), body: await request.json() }); return HttpResponse.json({ ok: true }); }));
      expect(await s.cli(...joinArgs, '--invite', 'ABCD2345', '--json')).toBe(ExitCode.OK);
      expect(seen).toEqual([{ auth: 'Bearer a-pool-token', body: { code: 'ABCD2345' } }]);
      expect(s.calls.indexOf('POST /v1/invites/redeem')).toBeGreaterThan(s.calls.indexOf('POST /v1/login/poll'));
      expect(inviteOf(out(s))).toEqual({ redeemed: true });
      expect(out(s) + err(s)).not.toContain('a-pool-token');
    });

    it('treats an account that joined on an invite already as a run repeated and carries on', async () => {
      const s = await scene();
      server.use(http.post(`${POOL}/v1/invites/redeem`, () => HttpResponse.json({ error: 'already_vouched', message: 'This account joined on an invite already.' }, { status: 409 })));
      expect(await s.cli(...joinArgs, '--invite', 'ABCD2345', '--json')).toBe(ExitCode.OK);
      expect(inviteOf(out(s))).toEqual({ skipped: true, reason: 'already_vouched' });
    });

    it('stops with the pool\'s own words when the code is refused, and says to rerun without it or with a new code', async () => {
      const s = await scene();
      server.use(http.post(`${POOL}/v1/invites/redeem`, () => HttpResponse.json({ error: 'invite_used', message: 'That invite code has been used.' }, { status: 409 })));
      expect(await s.cli(...joinArgs, '--invite', 'ABCD2345')).not.toBe(ExitCode.OK);
      expect(err(s)).toContain('That invite code has been used.');
      expect(count(s, 'POST /v1/deposits')).toBe(0);
      expect(err(s)).toContain('without --invite, or with a new code');
      expect(err(s)).not.toContain(AGAIN);
    });

    it('records no stopped event for a step already recorded done or skipped: a refused invite after sign-in ends the log at sign-in', async () => {
      const s = await scene();
      const events = watching(s);
      server.use(http.post(`${POOL}/v1/invites/redeem`, () => HttpResponse.json({ error: 'invite_used', message: 'That invite code has been used.' }, { status: 409 })));
      expect(await s.cli(...joinArgs, '--invite', 'ABCD2345')).not.toBe(ExitCode.OK);
      expect(events('join-step').map((event) => event.data)).toEqual([{ step: 'signin', state: 'done' }]);
    });

    it('keeps the crew number /v1/me states, for the card', async () => {
      const s = await scene();
      server.use(http.get(`${POOL}/v1/me`, () => HttpResponse.json({ account: 'acct_one', crewNumber: 7 })));
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      expect(await crewNumberOf(s.staged.storeDir, POOL, 'acct_one')).toBe(7);
    });

    it('joins all the same when /v1/me fails, and keeps no crew number', async () => {
      const s = await scene();
      server.use(http.get(`${POOL}/v1/me`, () => new HttpResponse(null, { status: 500 })));
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      expect(await crewNumberOf(s.staged.storeDir, POOL, 'acct_one')).toBeUndefined();
    });

    it('asks the pool nothing about invites without --invite', async () => {
      const s = await scene();
      expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
      expect(s.calls.filter((call) => call.includes('invites'))).toEqual([]);
    });

    it('lists --invite in the help', async () => {
      const s = await scene();
      expect(await s.cli('pool', 'join', '--help')).toBe(ExitCode.OK);
      expect(out(s)).toContain('--invite');
    });
  });
});
