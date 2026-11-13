// `oars pool invite`: posts the sign-in token to /v1/invites, prints the code once with the join line and what the vouch earns, and says what the pool refused in the pool's words.
import { mkdirSync, writeFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, server, useServer } from '../test-support.js';
import { crewNumberOf } from './crew-mark.js';
import { joinLineOf } from './pool-command.js';
import { signInsFile } from './pool-replica.js';
import { cleanup, settledClock, stage } from './test-support.js';

useServer();
afterEach(cleanup);

const POOL = 'https://pool.test';
const TOKEN = 'a-pool-token-for-invite';

const scene = (expiresAt = Date.parse('2099-01-01T00:00:00Z')) => {
  const staged = stage();
  const h = harness({});
  h.deps.sessions = staged.runtime;
  h.deps.now = settledClock;
  mkdirSync(staged.storeDir, { recursive: true });
  writeFileSync(signInsFile(staged.storeDir), JSON.stringify([{ server: POOL, account: 'acct_one', token: TOKEN, expiresAt, signingKeys: { k1: { kty: 'OKP', crv: 'Ed25519', x: 'a-pinned-key' } } }]));
  return { h, storeDir: staged.storeDir, cli: (...args: string[]): Promise<ExitCode> => run(args, h.deps) };
};

describe('oars pool invite', () => {
  it('keeps the crew number the pool states, for the card', async () => {
    const s = scene();
    server.use(
      http.post(`${POOL}/v1/invites`, () => HttpResponse.json({ code: 'ABCD2345', invitesLeft: 2 }, { status: 201 })),
      http.get(`${POOL}/v1/me`, ({ request }) => (request.headers.get('authorization') === `Bearer ${TOKEN}` ? HttpResponse.json({ crewNumber: 12 }) : new HttpResponse(null, { status: 401 }))),
    );
    expect(await s.cli('pool', 'invite', '--server', POOL)).toBe(ExitCode.OK);
    expect(await crewNumberOf(s.storeDir, POOL)).toBe(12);
  });

  it('prints the invite all the same when the crew number cannot be read', async () => {
    const s = scene();
    server.use(http.post(`${POOL}/v1/invites`, () => HttpResponse.json({ code: 'ABCD2345', invitesLeft: 2 }, { status: 201 })), http.get(`${POOL}/v1/me`, () => new HttpResponse(null, { status: 500 })));
    expect(await s.cli('pool', 'invite', '--server', POOL)).toBe(ExitCode.OK);
    expect(await crewNumberOf(s.storeDir, POOL)).toBeUndefined();
  });

  it('prints the code once, the line to hand on, and what the vouch earns, without the token', async () => {
    const s = scene();
    const seen: Array<string | null> = [];
    server.use(
      http.post(`${POOL}/v1/invites`, ({ request }) => { seen.push(request.headers.get('authorization')); return HttpResponse.json({ code: 'ABCD2345', invitesLeft: 2 }, { status: 201 }); }),
      http.get(`${POOL}/v1/me`, () => HttpResponse.json({ crewNumber: 12, vouchesGiven: 4 })),
    );
    expect(await s.cli('pool', 'invite', '--server', POOL)).toBe(ExitCode.OK);
    expect(seen).toEqual([`Bearer ${TOKEN}`]);
    const printed = s.h.out.join('');
    expect(printed).toContain('Invite code: ABCD2345');
    expect(printed).toContain(joinLineOf('ABCD2345'));
    expect(printed).toContain('only time the code is shown');
    expect(printed).toContain('two counting weeks');
    expect(printed).toContain('you have vouched for 4 so far');
    expect(printed).toContain('Open codes you can still make: 2.');
    expect(printed).not.toContain(TOKEN);
  });

  it('prints the code, the join line, and the codes left as JSON', async () => {
    const s = scene();
    server.use(http.post(`${POOL}/v1/invites`, () => HttpResponse.json({ code: 'ABCD2345', invitesLeft: 0 }, { status: 201 })));
    expect(await s.cli('pool', 'invite', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(JSON.parse(s.h.out.join(''))).toEqual({ ok: true, server: POOL, code: 'ABCD2345', join: joinLineOf('ABCD2345'), invitesLeft: 0 });
  });

  it('still prints when the pool names no count of codes left', async () => {
    const s = scene();
    server.use(http.post(`${POOL}/v1/invites`, () => HttpResponse.json({ code: 'ABCD2345' }, { status: 201 })));
    expect(await s.cli('pool', 'invite', '--server', POOL)).toBe(ExitCode.OK);
    expect(s.h.out.join('')).not.toContain('Open codes you can still make');
  });

  it('names the pool\'s refusal when the account may not vouch or holds three open codes', async () => {
    const s = scene();
    server.use(http.post(`${POOL}/v1/invites`, () => HttpResponse.json({ error: 'invite_limit', message: 'An account holds at most 3 open invite codes.' }, { status: 409 })));
    expect(await s.cli('pool', 'invite', '--server', POOL)).not.toBe(ExitCode.OK);
    expect(s.h.err.join('')).toContain('An account holds at most 3 open invite codes.');
  });

  it('fails when the pool answers a created invite with no code', async () => {
    const s = scene();
    server.use(http.post(`${POOL}/v1/invites`, () => HttpResponse.json({}, { status: 201 })));
    expect(await s.cli('pool', 'invite', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
  });

  it('says to run oars pool login first when the sign-in has lapsed, and asks the pool nothing', async () => {
    const asked: string[] = [];
    server.use(http.post(`${POOL}/v1/invites`, ({ request }) => { asked.push(request.url); return HttpResponse.json({}); }));
    const lapsed = scene(Date.parse('2000-01-01T00:00:00Z'));
    expect(await lapsed.cli('pool', 'invite', '--server', POOL)).toBe(ExitCode.AUTH);
    expect(lapsed.h.err.join('')).toContain('Run oars pool login first.');
    expect(asked).toEqual([]);
  });
});
