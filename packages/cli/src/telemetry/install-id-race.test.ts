// Two first runs at once must share one install id. The race is made deterministic: the id this process minted is not yet on disk when the other
// process (here, the mock) writes its own, so the exclusive create must lose and the loser must adopt the winner's id.
import type * as NodeCrypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfigDir } from '../credentials.js';
import { installId, spoolPaths } from './spool.js';

const rival = vi.hoisted(() => ({ beforeReturn: (): void => undefined }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return {
    ...actual,
    randomUUID: (): `${string}-${string}-${string}-${string}-${string}` => {
      rival.beforeReturn();
      return actual.randomUUID();
    },
  };
});

const roots: string[] = [];
const folder = (): string => {
  const appData = mkdtempSync(join(tmpdir(), 'oars-id-race-'));
  roots.push(appData);
  const configDir = defaultConfigDir({ APPDATA: appData }, 'win32', 'C:\\unused-home');
  expect(configDir).toBe(appData);
  return join(configDir, 'oars', 'telemetry');
};
beforeEach(() => {
  rival.beforeReturn = (): void => undefined;
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RIVAL_ID = '11111111-1111-4111-8111-111111111111';

describe('the install id under a first-run race', () => {
  it('two writers, one id: the loser of the exclusive create adopts the winner', () => {
    const dir = folder();
    const { idFile } = spoolPaths(dir);
    rival.beforeReturn = (): void => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(idFile, `${RIVAL_ID}\n`);
    };
    expect(installId(dir)).toBe(RIVAL_ID);
    expect(readFileSync(idFile, 'utf8').trim()).toBe(RIVAL_ID);
    expect(installId(dir)).toBe(RIVAL_ID);
  });

  it('throws, for the caller to swallow, when the id file cannot be created and nobody else wrote a valid id', () => {
    const dir = folder();
    mkdirSync(spoolPaths(dir).idFile, { recursive: true });
    expect(() => installId(dir)).toThrow();
  });
});
