import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { harness } from '../test-support.js';
import { cardOf } from './card.js';
import { PITCH, cardSvg } from './card-render.js';
import { CARD_NOW, cardStore, cardSurvival } from './card-fixture.js';
import type { SessionsDeps } from './command.js';
import type * as StoreModule from './store.js';

vi.mock('./store.js', async (original) => ({ ...(await original<typeof StoreModule>()), loadStore: () => Promise.resolve(cardStore()) }));
vi.mock('./survival.js', () => ({ readSurvival: () => Promise.resolve(cardSurvival()) }));

const { depositorLine, sessionsCard } = await import('./card-command.js');
const { outboxFolder } = await import('./pool-outbox.js');
const { signInsFile } = await import('./pool-replica.js');
const { crewNumberOf, keepCrewNumber } = await import('./crew-mark.js');

const SERVER = 'https://pool.manyoars.com';
const KEYS = { k1: { kty: 'OKP', crv: 'Ed25519', x: 'a-pinned-key' } };
const ASHORE = 'ashore: run oars pool login';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oars-card-depositor-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const signIn = (expiresAt: number, server: string = SERVER): void => {
  writeFileSync(signInsFile(dir), JSON.stringify([{ server, account: 'acct_one', token: 'secret-token', expiresAt, signingKeys: KEYS }]));
};

/** Three sends in two Monday-start weeks (Mon 2026-11-02 and Sun 2026-11-08 share one; Mon 2026-10-26 is another), plus a line with no readable time. */
const sent = (): void => {
  const outbox = outboxFolder(dir, SERVER);
  mkdirSync(outbox, { recursive: true });
  writeFileSync(join(outbox, 'sent.log'), ['aaa 2026-11-02T00:00:00.000Z', 'bbb 2026-11-08T23:59:59.000Z', 'ccc 2026-10-26T09:00:00.000Z', 'ddd not-a-time', ''].join('\n'));
};

describe('depositorLine', () => {
  it('reads ashore when nobody is signed in', async () => {
    expect(await depositorLine(dir, {}, CARD_NOW)).toBe(ASHORE);
  });

  it('reads the weeks this machine sent a deposit when signed in', async () => {
    signIn(CARD_NOW + 1000);
    sent();
    expect(await depositorLine(dir, {}, CARD_NOW)).toBe('weeks rowing (this machine): 2');
  });

  it('counts zero weeks for a signed-in machine that has sent nothing', async () => {
    signIn(CARD_NOW + 1000);
    expect(await depositorLine(dir, {}, CARD_NOW)).toBe('weeks rowing (this machine): 0');
  });

  it('reads ashore for a lapsed sign-in, one for another server, an unreadable file, and a bad pool address', async () => {
    sent();
    signIn(CARD_NOW - 1);
    expect(await depositorLine(dir, {}, CARD_NOW)).toBe(ASHORE);
    signIn(CARD_NOW + 1000, 'https://pool.example.com');
    expect(await depositorLine(dir, {}, CARD_NOW)).toBe(ASHORE);
    writeFileSync(signInsFile(dir), 'not json');
    expect(await depositorLine(dir, {}, CARD_NOW)).toBe(ASHORE);
    expect(await depositorLine(dir, { OARS_POOL_URL: 'not a url' }, CARD_NOW)).toBe(ASHORE);
  });

  it('adds the founding crew mark when this machine learned a number for this pool, and drops it for another pool or a file that is not ours', async () => {
    signIn(CARD_NOW + 1000);
    sent();
    await keepCrewNumber(dir, SERVER, 12);
    expect(await depositorLine(dir, {}, CARD_NOW)).toBe('weeks rowing (this machine): 2 · founding crew #12');
    await keepCrewNumber(dir, 'https://pool.example.com', 12);
    expect(await depositorLine(dir, {}, CARD_NOW)).toBe('weeks rowing (this machine): 2');
    await keepCrewNumber(dir, SERVER, undefined);
    expect(await depositorLine(dir, {}, CARD_NOW)).toBe('weeks rowing (this machine): 2');
    writeFileSync(join(dir, 'pool-crew.json'), 'not json');
    expect(await depositorLine(dir, {}, CARD_NOW)).toBe('weeks rowing (this machine): 2');
    expect(await crewNumberOf(dir, SERVER)).toBeUndefined();
  });

  it('shows no crew mark for a number kept for another account than the one signed in now', async () => {
    signIn(CARD_NOW + 1000);
    sent();
    await keepCrewNumber(dir, SERVER, 'acct_two', 12);
    expect(await depositorLine(dir, {}, CARD_NOW)).toBe('weeks rowing (this machine): 2');
    await keepCrewNumber(dir, SERVER, 'acct_one', 12);
    expect(await depositorLine(dir, {}, CARD_NOW)).toBe('weeks rowing (this machine): 2 · founding crew #12');
  });

  it('does not swallow an error that is not the command\'s own', async () => {
    mkdirSync(signInsFile(dir));
    await expect(depositorLine(dir, {}, CARD_NOW)).rejects.toThrow();
  });
});

describe('sessionsCard depositor row', () => {
  const deps = (): SessionsDeps => ({ sessions: { storeDir: dir, projectsRoot: join(dir, 'projects'), stdin: process.stdin, stdout: { write: () => true } }, install: undefined, now: () => CARD_NOW });

  it('signed out, the table reads ashore: run oars pool login', async () => {
    const outcome = await sessionsCard(deps(), { period: 'week', text: true }, {});
    expect(outcome.text).toContain(`depositor            ${ASHORE}`);
    expect(outcome.text).not.toContain('weeks rowing');
  });

  it('signed in, the table reads the weeks from the sent record and the sign-in token stays out', async () => {
    signIn(CARD_NOW + 1000);
    sent();
    const outcome = await sessionsCard(deps(), { period: 'week', text: true }, {});
    expect(outcome.text).toContain('depositor            weeks rowing (this machine): 2');
    expect(outcome.text).not.toContain(ASHORE);
    expect(JSON.stringify(outcome)).not.toContain('secret-token');
    expect(JSON.stringify(outcome)).not.toContain('acct_one');
  });
});

describe('oars card through run', () => {
  const wired = (): ReturnType<typeof harness> => {
    const h = harness();
    h.deps.now = () => CARD_NOW;
    h.deps.sessions = { storeDir: dir, projectsRoot: join(dir, 'projects'), stdin: process.stdin, stdout: { write: () => true } };
    return h;
  };

  it('saves the SVG and the PNG, prints both paths and one tweet link, and reports them in --json', async () => {
    const png = join(dir, 'x.png');
    const svg = join(dir, 'x.svg');
    const h = wired();
    expect(await run(['card', '--month', '--out', png], h.deps)).toBe(0);
    expect(existsSync(png)).toBe(true);
    expect(existsSync(svg)).toBe(true);
    const card = cardOf(cardStore(), cardSurvival(), 'month', CARD_NOW);
    expect(card.days).toBe(30);
    expect(readFileSync(svg, 'utf8')).toBe(cardSvg(card, ASHORE));
    expect(readFileSync(svg, 'utf8')).toContain(ASHORE);
    expect(readFileSync(png).readUInt32BE(16)).toBe(1200);
    const printed = h.out.join('');
    expect(printed).toContain(`Saved ${resolve(png)}`);
    expect(printed).toContain(`Saved ${resolve(svg)}`);
    expect(printed.match(/https:\/\/x\.com\/intent\/tweet\?text=/g)).toHaveLength(1);

    const json = wired();
    expect(await run(['card', '--month', '--out', png, '--json'], json.deps)).toBe(0);
    expect(JSON.parse(json.out.join(''))).toMatchObject({ saved: { png: resolve(png), svg: resolve(svg) } });
  });

  it('--year --text names the last 365 days', async () => {
    const h = wired();
    expect(await run(['card', '--year', '--text'], h.deps)).toBe(0);
    expect(h.out.join('')).toContain('the last 365 days');
  });

  it('--no-cost leaves the cost row and every dollar out of the picture, the table, and the JSON', async () => {
    const png = join(dir, 'free.png');
    const svg = join(dir, 'free.svg');
    expect(await run(['card', '--month', '--out', png, '--no-cost'], wired().deps)).toBe(0);
    expect(readFileSync(svg, 'utf8')).not.toContain('$');
    expect(readFileSync(svg, 'utf8')).not.toContain('cost');
    const withCost = join(dir, 'with.png');
    await run(['card', '--month', '--out', withCost], wired().deps);
    const height = (path: string): number => Number(/height="(\d+)"/.exec(readFileSync(path, 'utf8'))?.[1]);
    expect(height(join(dir, 'with.svg')) - height(svg)).toBe(PITCH);

    const table = wired();
    expect(await run(['card', '--month', '--text', '--no-cost'], table.deps)).toBe(0);
    expect(table.out.join('')).not.toMatch(/\$|cost/);

    const json = wired();
    expect(await run(['card', '--month', '--text', '--no-cost', '--json'], json.deps)).toBe(0);
    expect(json.out.join('')).not.toMatch(/\$|cost/);

    const kept = wired();
    await run(['card', '--month', '--text'], kept.deps);
    expect(kept.out.join('')).toContain('$1.75');
  });
});
