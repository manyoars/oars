// `oars pool enroll` without --hold-only: the pool issues the one-time token, and the printed block is the one --hold-only prints. The pool is a stand-in; nothing here reaches a network.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { harness, server, useServer } from '../test-support.js';
import { machinesFile, poolEnroll, type EnrollOptions, type Visibility } from './machine-enroll.js';
import { isObject, signInsFile } from './pool-replica.js';
import { cleanup, stage, type Staged } from './test-support.js';
import type { Harness } from '../test-support.js';

useServer();
afterEach(cleanup);

const POOL = 'https://pool.test';
const TOKEN = 'a'.repeat(64);
const LATER = Date.now() + 86_400_000;
const OPTIONS: EnrollOptions = { holdOnly: false, hostClass: 'cloud', launcher: 'scheduled', allowRepos: ['acme/widgets'], name: 'night runner', server: POOL };
const PRIVATE: Visibility = () => Promise.resolve('private');

const scene = (signedIn = true): { staged: Staged; h: Harness } => {
  const staged = stage();
  const terms = join(staged.root, 'terms.txt');
  writeFileSync(terms, 'zorblax\n');
  const h = harness({ OARS_EXCLUSION_TERMS: terms });
  h.deps.sessions = staged.runtime;
  if (signedIn) {
    mkdirSync(staged.storeDir, { recursive: true });
    writeFileSync(signInsFile(staged.storeDir), JSON.stringify([{ server: POOL, account: 'acct_one', token: 'a-pool-credential', expiresAt: Date.now() + 3_600_000, signingKey: { kty: 'OKP', crv: 'Ed25519', x: 'a-pinned-key' } }]));
  }
  return { staged, h };
};

interface Sent {
  authorization: string | null;
  body: unknown;
}

/** A pool that answers every enrollment with `status`, recording what arrived. */
const poolAnswering = (status: number, body: JsonBodyType, sent: Sent[]): void => {
  server.use(
    http.post(`${POOL}/v1/machines/enroll`, async ({ request }) => {
      sent.push({ authorization: request.headers.get('authorization'), body: await request.json() });
      return HttpResponse.json(body, { status });
    }),
  );
};
const CREATED = { machine: { id: 'pool-machine-id', label: 'night runner', expiresAt: LATER }, token: TOKEN };

const blockLines = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('OARS_') && !line.startsWith('OARS_MACHINE=') );

const usageRefusal = async (call: Promise<unknown>, message: RegExp): Promise<void> => {
  await expect(call).rejects.toThrow(message);
  await expect(call).rejects.toMatchObject({ exitCode: 2 });
};

describe('oars pool enroll (full)', () => {
  it('sends the declaration with the login, records the machine, and prints the token then the hold-only block', async () => {
    const { staged, h } = scene();
    const sent: Sent[] = [];
    poolAnswering(201, CREATED, sent);
    const full = await poolEnroll(h.deps, { ...OPTIONS, days: '30' }, PRIVATE);
    expect(sent).toEqual([{ authorization: 'Bearer a-pool-credential', body: { label: 'night runner', hostClass: 'cloud', launcher: 'scheduled', allowRepos: ['acme/widgets'], days: 30 } }]);
    expect(full.text).toContain(TOKEN);
    expect(full.text).toContain('24 hours');
    expect(full.document).toMatchObject({ ok: true, holdOnly: false, token: TOKEN, poolMachine: 'pool-machine-id' });
    const held = await poolEnroll(h.deps, { ...OPTIONS, holdOnly: true, name: undefined, days: undefined }, PRIVATE);
    expect(blockLines(full.text)).toEqual(blockLines(held.text));
    expect(full.text).toContain('OARS_SESSION_SALT=');
    const rows = readFileSync(machinesFile(staged.storeDir), 'utf8').trimEnd().split('\n');
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0] ?? '')).toMatchObject({ hostClass: 'cloud', launcher: 'scheduled', allowRepos: ['acme/widgets'] });
  });

  it('leaves the days out when none is given, so the pool takes its default', async () => {
    const { h } = scene();
    const sent: Sent[] = [];
    poolAnswering(201, CREATED, sent);
    await poolEnroll(h.deps, OPTIONS, PRIVATE);
    expect(sent[0]?.body).not.toHaveProperty('days');
  });

  it('refuses a public repository and one it cannot confirm with nothing sent and nothing recorded', async () => {
    const { staged, h } = scene();
    const sent: Sent[] = [];
    poolAnswering(201, CREATED, sent);
    await usageRefusal(poolEnroll(h.deps, OPTIONS, () => Promise.resolve('public')), /acme\/widgets is public/u);
    await usageRefusal(poolEnroll(h.deps, OPTIONS, () => Promise.resolve('unknown')), /GH_TOKEN or GITHUB_TOKEN/u);
    expect(sent).toEqual([]);
    expect(existsSync(machinesFile(staged.storeDir))).toBe(false);
  });

  it('records nothing when the pool refuses, and names the pool\'s reason', async () => {
    const { staged, h } = scene();
    const sent: Sent[] = [];
    poolAnswering(401, { error: 'unauthorized', message: 'Sign in with oars pool login first.' }, sent);
    await expect(poolEnroll(h.deps, OPTIONS, PRIVATE)).rejects.toThrow(/Sign in with oars pool login first/u);
    expect(existsSync(machinesFile(staged.storeDir))).toBe(false);
  });

  it('needs the login, asking the pool nothing without it', async () => {
    const { staged, h } = scene(false);
    const sent: Sent[] = [];
    poolAnswering(201, CREATED, sent);
    await expect(poolEnroll(h.deps, OPTIONS, PRIVATE)).rejects.toThrow(/oars pool login/u);
    expect(sent).toEqual([]);
    expect(existsSync(machinesFile(staged.storeDir))).toBe(false);
  });

  it.each(['0', '366', '1.5', '-1', 'abc', '', '1e2'])('refuses --days %j locally, with the pool\'s wording, before anything is checked', async (days) => {
    const { h } = scene();
    const sent: Sent[] = [];
    poolAnswering(201, CREATED, sent);
    await usageRefusal(poolEnroll(h.deps, { ...OPTIONS, days }, PRIVATE), /days is a whole number of days from 1 to 365/u);
    expect(sent).toEqual([]);
  });

  it('accepts the ends of the range', async () => {
    const { h } = scene();
    const sent: Sent[] = [];
    poolAnswering(201, CREATED, sent);
    for (const days of ['1', '365']) await poolEnroll(h.deps, { ...OPTIONS, days }, PRIVATE);
    const sentDays = sent.map((one): unknown => (isObject(one.body) ? Reflect.get(one.body, 'days') : undefined));
    expect(sentDays).toEqual([1, 365]);
  });

  it('names the host of the pool asked, not a fixed one, in the advice for the token', async () => {
    const { h } = scene();
    poolAnswering(201, CREATED, []);
    const outcome = await poolEnroll(h.deps, OPTIONS, PRIVATE);
    expect(outcome.text).toContain('host pool.test)');
    expect(outcome.text).not.toContain('pool.manyoars.com');
  });

  it('refuses the hosted class locally, before GitHub or the pool is asked', async () => {
    const { staged, h } = scene();
    const sent: Sent[] = [];
    poolAnswering(201, CREATED, sent);
    const visibility = vi.fn(PRIVATE);
    await usageRefusal(poolEnroll(h.deps, { ...OPTIONS, hostClass: 'hosted' }, visibility), /vps, cloud, or ci.*Nothing was checked\./u);
    expect(visibility).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(existsSync(machinesFile(staged.storeDir))).toBe(false);
  });

  it('needs a label', async () => {
    const { h } = scene();
    await usageRefusal(poolEnroll(h.deps, { ...OPTIONS, name: undefined }, PRIVATE), /--name/u);
    await usageRefusal(poolEnroll(h.deps, { ...OPTIONS, name: '' }, PRIVATE), /--name/u);
  });

  it('fails, recording nothing, when the pool answers 201 without a token', async () => {
    const { staged, h } = scene();
    for (const body of [{}, { token: TOKEN }, { token: TOKEN, machine: { id: 'x' } }, null]) {
      poolAnswering(201, body, []);
      await expect(poolEnroll(h.deps, OPTIONS, PRIVATE)).rejects.toThrow(/did not answer the enrollment/u);
    }
    expect(existsSync(machinesFile(staged.storeDir))).toBe(false);
  });

  it('runs through the CLI with --name, --days, and --server', async () => {
    const { h } = scene();
    h.deps.env.GH_TOKEN = 'a-test-token';
    const sent: Sent[] = [];
    poolAnswering(201, CREATED, sent);
    server.use(http.get('https://api.github.com/repos/acme/widgets', () => HttpResponse.json({ private: true })));
    const code = await run(['pool', 'enroll', '--host-class', 'cloud', '--launcher', 'scheduled', '--allow-repos', 'acme/widgets', '--name', 'night runner', '--days', '7', '--server', POOL, '--json'], h.deps);
    expect(code).toBe(0);
    expect(sent[0]?.body).toMatchObject({ label: 'night runner', days: 7 });
    expect(JSON.parse(h.out.join(''))).toMatchObject({ ok: true, token: TOKEN });
  });
});
