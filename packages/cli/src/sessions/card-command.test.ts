import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cardPaths, sessionsCard } from './card-command.js';
import { CARD_NOW } from './card-fixture.js';
import type { SessionsDeps } from './command.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oars-card-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const depsOf = (storeDir: string | undefined): SessionsDeps => ({
  sessions: storeDir === undefined ? undefined : { storeDir, projectsRoot: join(dir, 'projects'), stdin: process.stdin, stdout: { write: () => true } },
  install: undefined,
  now: () => CARD_NOW,
});

describe('cardPaths', () => {
  it('names one picture of each kind from --out, or from the period in the working directory', () => {
    expect(cardPaths('week', join(dir, 'mine.png'))).toEqual({ svg: resolve(dir, 'mine.svg'), png: resolve(dir, 'mine.png') });
    expect(cardPaths('month', join(dir, 'mine.SVG')).png).toBe(resolve(dir, 'mine.png'));
    expect(cardPaths('year', undefined)).toEqual({ svg: resolve('oars-card-year.svg'), png: resolve('oars-card-year.png') });
  });

  it('refuses a path that is neither a .png nor a .svg', () => {
    expect(() => cardPaths('week', join(dir, 'mine.jpg'))).toThrow('must end in .png or .svg');
  });
});

describe('sessionsCard', () => {
  it('says the store is empty over an empty store and writes no picture', async () => {
    const out = join(dir, 'card.png');
    const outcome = await sessionsCard(depsOf(join(dir, 'store')), { period: 'week', text: false, out }, {});
    expect(outcome.text).toContain('deposit');
    expect(outcome.document).toMatchObject({ ok: true, saved: null, tweet: null });
  });

  it('stops when the run has no session store', async () => {
    await expect(sessionsCard(depsOf(undefined), { period: 'week', text: true }, {})).rejects.toThrow('not configured');
  });
});
