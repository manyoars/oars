import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, formatPolicy, loadPolicy, policyPath } from './policy.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const store = (body?: string): string => {
  const one = mkdtempSync(join(tmpdir(), 'oars-gate-policy-'));
  made.push(one);
  if (body !== undefined) writeFileSync(policyPath(one), body);
  return one;
};

describe('the gate policy file', () => {
  it('reads as the defaults when there is no file: young names warn, not-found warns, nothing blocks, ten percent held back', async () => {
    expect(await loadPolicy(store())).toEqual({ policy: DEFAULT_POLICY, source: 'default' });
    expect(DEFAULT_POLICY).toEqual({ classes: { 'young-name': 'warn', 'not-found': 'warn' }, youngDays: 30, holdbackPercent: 10 });
  });

  it('reads a class setting, the day count, and the holdback share, and keeps the default for what it does not name', async () => {
    const read = await loadPolicy(store('{"v":1,"classes":{"not-found":"block"},"holdbackPercent":0}'));
    expect(read).toEqual({ policy: { classes: { 'young-name': 'warn', 'not-found': 'block' }, youngDays: 30, holdbackPercent: 0 }, source: 'file' });
    expect((await loadPolicy(store('{"classes":{"young-name":"off","not-found":"off"},"youngDays":7,"holdbackPercent":100}'))).policy).toEqual({ classes: { 'young-name': 'off', 'not-found': 'off' }, youngDays: 7, holdbackPercent: 100 });
    expect(await loadPolicy(store('{}'))).toEqual({ policy: DEFAULT_POLICY, source: 'file' });
  });

  it.each([
    ['not JSON', '{"classes":'],
    ['an array', '[]'],
    ['a string', '"warn"'],
    ['an unknown key', '{"mode":"block"}'],
    ['an unknown class', '{"classes":{"other":"warn"}}'],
    ['a free-text action', '{"classes":{"not-found":"deny"}}'],
    ['a block on a young name, which only warns or is off', '{"classes":{"young-name":"block"}}'],
    ['classes of the wrong shape', '{"classes":"warn"}'],
    ['a holdback over 100', '{"holdbackPercent":101}'],
    ['a negative holdback', '{"holdbackPercent":-1}'],
    ['a fractional holdback', '{"holdbackPercent":2.5}'],
    ['a holdback that is text', '{"holdbackPercent":"10"}'],
    ['a day count of 0', '{"youngDays":0}'],
    ['a day count over 365', '{"youngDays":366}'],
    ['another version', '{"v":2}'],
  ])('reads %s as the defaults and says it was invalid, never throwing', async (_name, body) => {
    expect(await loadPolicy(store(body))).toEqual({ policy: DEFAULT_POLICY, source: 'invalid' });
  });

  it('reads an unreadable file as the defaults and invalid', async () => {
    const dir = store();
    mkdirSync(policyPath(dir));
    expect(await loadPolicy(dir)).toEqual({ policy: DEFAULT_POLICY, source: 'invalid' });
  });

  it('prints the policy in force, the file it came from, and what an invalid file did', () => {
    const lines = formatPolicy({ policy: DEFAULT_POLICY, source: 'default' }, '/store/gate-policy.json');
    expect(lines).toContain('Policy in force: defaults (no file at /store/gate-policy.json)');
    expect(lines).toContain('young-name: warn');
    expect(lines).toContain('not-found: warn');
    expect(lines).toContain('Young name: first published within 30 days');
    expect(lines).toContain('Holdback: 10% of notes are not shown');
    expect(formatPolicy({ policy: DEFAULT_POLICY, source: 'invalid' }, '/store/gate-policy.json')).toContain('Policy in force: defaults (/store/gate-policy.json is unreadable or invalid, so it is ignored)');
    expect(formatPolicy({ policy: { ...DEFAULT_POLICY, classes: { 'young-name': 'warn', 'not-found': 'block' } }, source: 'file' }, '/store/gate-policy.json')).toContain('Policy in force: /store/gate-policy.json');
  });
});
