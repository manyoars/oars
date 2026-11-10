// `oars pool prove` and the closed-account sign-in of `oars pool login`: both print the account and the proof time the pool stored, in text and in --json, so the person can send them to the operator who asked for proof (GDPR Art. 12(6)).
import { mkdirSync, writeFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, server, useServer } from '../test-support.js';
import { signInsFile } from './pool-replica.js';
import { cleanup, settledClock, stage } from './test-support.js';

useServer();
afterEach(cleanup);

const POOL = 'https://pool.test';
const TOKEN = 'a-pool-token-for-prove';
const PROVED_AT = Date.parse('2026-11-10T12:30:00.000Z');
const LINES = ['account: acct_one', `provedAt: ${String(PROVED_AT)}`];

const scene = (expiresAt = Date.parse('2099-01-01T00:00:00Z')) => {
  const staged = stage();
  const h = harness({});
  h.deps.sessions = staged.runtime;
  h.deps.now = settledClock;
  mkdirSync(staged.storeDir, { recursive: true });
  writeFileSync(signInsFile(staged.storeDir), JSON.stringify([{ server: POOL, account: 'acct_one', token: TOKEN, expiresAt, signingKeys: { k1: { kty: 'OKP', crv: 'Ed25519', x: 'a-pinned-key' } } }]));
  return { h, cli: (...args: string[]): Promise<ExitCode> => run(args, h.deps), storeDir: staged.storeDir };
};

describe('oars pool prove', () => {
  it('posts the sign-in token to /v1/account/proof and prints the account and the time, to send in reply', async () => {
    const s = scene();
    const seen: Array<{ auth: string | null; method: string }> = [];
    server.use(http.post(`${POOL}/v1/account/proof`, ({ request }) => { seen.push({ auth: request.headers.get('authorization'), method: request.method }); return HttpResponse.json({ account: 'acct_one', provedAt: PROVED_AT }); }));
    expect(await s.cli('pool', 'prove', '--server', POOL)).toBe(ExitCode.OK);
    expect(seen).toEqual([{ auth: `Bearer ${TOKEN}`, method: 'POST' }]);
    const printed = s.h.out.join('');
    expect(printed).toContain('Proof recorded for acct_one at 2026-11-10T12:30:00.000Z.');
    expect(printed).toContain('Send these two lines in reply to the privacy@manyoars.com message that asked you for proof:');
    expect(printed).toContain(LINES.join('\n'));
    expect(printed).not.toContain(TOKEN);
  });

  it('prints the account and provedAt as JSON with --json', async () => {
    const s = scene();
    server.use(http.post(`${POOL}/v1/account/proof`, () => HttpResponse.json({ account: 'acct_one', provedAt: PROVED_AT })));
    expect(await s.cli('pool', 'prove', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(JSON.parse(s.h.out.join(''))).toEqual({ ok: true, server: POOL, account: 'acct_one', provedAt: PROVED_AT });
  });

  it('says to run oars pool login first when the sign-in has lapsed or is missing, and asks the pool nothing', async () => {
    const asked: string[] = [];
    server.use(http.post(`${POOL}/v1/account/proof`, ({ request }) => { asked.push(request.url); return HttpResponse.json({}); }));
    const lapsed = scene(Date.parse('2000-01-01T00:00:00Z'));
    expect(await lapsed.cli('pool', 'prove', '--server', POOL)).toBe(ExitCode.AUTH);
    expect(lapsed.h.err.join('')).toContain('Run oars pool login first.');
    const other = scene();
    expect(await other.cli('pool', 'prove', '--server', 'https://other.test')).toBe(ExitCode.AUTH);
    expect(asked).toEqual([]);
  });

  it('names the pool\'s refusal, and refuses an answer with no account or time', async () => {
    const s = scene();
    server.use(http.post(`${POOL}/v1/account/proof`, () => HttpResponse.json({ error: 'unauthorized', message: 'Sign in with oars pool login first.' }, { status: 401 })));
    expect(await s.cli('pool', 'prove', '--server', POOL)).toBe(ExitCode.AUTH);
    expect(s.h.err.join('')).toContain('Sign in with oars pool login first.');
    const odd = scene();
    server.use(http.post(`${POOL}/v1/account/proof`, () => HttpResponse.json({ account: 'acct_one' })));
    expect(await odd.cli('pool', 'prove', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
    expect(odd.h.err.join('')).toContain('no account or proof time');
  });
});

describe('oars pool login on a closed account', () => {
  const closedPool = (): void => {
    server.use(
      http.post(`${POOL}/v1/login/start`, () => HttpResponse.json({ handle: 'a-handle', userCode: 'USER-1', verificationUrl: 'https://provider.test/device', interval: 2, expiresIn: 10 })),
      http.post(`${POOL}/v1/login/poll`, () => HttpResponse.json({ error: 'account_closed', message: 'This account is closed. Your sign-in was recorded at 2026-11-10T12:30:00.000Z as proof that you control it. To make a request about it, write to privacy@manyoars.com; if we asked you for proof, reply with the account and that time.', account: 'acct_one', provedAt: PROVED_AT }, { status: 403 })),
    );
  };

  it('prints the pool\'s message, the two lines to send, and that the operator will ask for them', async () => {
    const s = scene();
    closedPool();
    expect(await s.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.AUTH);
    const printed = s.h.err.join('');
    expect(printed).toContain('This account is closed. Your sign-in was recorded at 2026-11-10T12:30:00.000Z');
    expect(printed).toContain('The operator will ask for these two lines when you write to privacy@manyoars.com:');
    expect(printed).toContain(LINES.join('\n'));
  });

  it('prints the account and provedAt as JSON beside the problem with --json', async () => {
    const s = scene();
    closedPool();
    expect(await s.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(JSON.parse(s.h.out.join(''))).toMatchObject({ ok: false, step: 'pool-login', problem: { code: 'account_closed', status: 403 }, account: 'acct_one', provedAt: PROVED_AT });
  });
});
