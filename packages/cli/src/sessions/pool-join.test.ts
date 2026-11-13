import { webcrypto } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, server, useServer, type Harness } from '../test-support.js';
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
}

/** A fake pool with the device flow answered at once, the covenant already accepted, and every route recording its request. */
const scene = async (routes: Routes = {}): Promise<Scene> => {
  const staged = stage();
  const termsFile = join(staged.root, 'terms.txt');
  writeFileSync(termsFile, 'zorblax\n');
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

const AGAIN = 'Run oars pool join again to continue from here.';

describe('oars pool join', () => {
  it('takes a first-time person from nothing to a sent deposit and a fetched bundle, in the order of the five commands', async () => {
    const s = await scene();
    await capture(s);
    expect(await s.cli(...joinArgs)).toBe(ExitCode.OK);
    // The fixture store holds several sessions, so several batches: each is sent the way `deposit --send <hash>` sends one (the covenant read, then the post).
    const batches = outboxFiles(s).length;
    expect(batches).toBeGreaterThan(1);
    expect(s.calls).toEqual(['POST /v1/login/start', 'POST /v1/login/poll', ...Array.from({ length: batches }, () => ['GET /v1/covenant', 'POST /v1/deposits']).flat(), `GET /bundle/claude-code/${VERSION}/${VOCAB_VERSION}`]);
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
      expect(out(s).replace(/\s+/g, ' ')).toContain('join [options] run login, deposit, outbox --explain, deposit --send, and fetch in one command');
    });

    it('oars pool join --help describes it in one or two short sentences and takes the flags the five commands take', async () => {
      const s = await scene();
      expect(await s.cli('pool', 'join', '--help')).toBe(ExitCode.OK);
      const help = out(s);
      expect(help).toContain('run login, deposit, outbox --explain, deposit --send, and fetch in one command');
      for (const option of ['--provider', '--harness-version', '--harness', '--accept-covenant', '--in-eu-eea-uk', '--verbose', '--server']) expect(help).toContain(option);
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
      expect(JSON.parse(out(s)).invite).toEqual({ redeemed: true });
      expect(out(s) + err(s)).not.toContain('a-pool-token');
    });

    it('treats an account that joined on an invite already as a run repeated and carries on', async () => {
      const s = await scene();
      server.use(http.post(`${POOL}/v1/invites/redeem`, () => HttpResponse.json({ error: 'already_vouched', message: 'This account joined on an invite already.' }, { status: 409 })));
      expect(await s.cli(...joinArgs, '--invite', 'ABCD2345', '--json')).toBe(ExitCode.OK);
      expect(JSON.parse(out(s)).invite).toEqual({ skipped: true, reason: 'already_vouched' });
    });

    it('stops with the pool\'s own words when the code is refused, and says to run join again', async () => {
      const s = await scene();
      server.use(http.post(`${POOL}/v1/invites/redeem`, () => HttpResponse.json({ error: 'invite_used', message: 'That invite code has been used.' }, { status: 409 })));
      expect(await s.cli(...joinArgs, '--invite', 'ABCD2345')).not.toBe(ExitCode.OK);
      expect(err(s)).toContain('That invite code has been used.');
      expect(count(s, 'POST /v1/deposits')).toBe(0);
      expect(err(s)).toContain(AGAIN);
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
