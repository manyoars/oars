import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfigDir } from '../credentials.js';
import { consentOf, markNoticeShown, NOTICE, setEnabled, telemetrySendAllowed } from './consent.js';
import { spoolPaths } from './spool.js';

const roots: string[] = [];
const folder = (): string => {
  const appData = mkdtempSync(join(tmpdir(), 'oars-consent-'));
  roots.push(appData);
  // The store follows APPDATA (t754): confirm the config folder is the temp one before the telemetry folder goes under it.
  const configDir = defaultConfigDir({ APPDATA: appData }, 'win32', 'C:\\unused-home');
  expect(configDir).toBe(appData);
  return join(configDir, 'oars', 'telemetry');
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('consentOf', () => {
  it('is on by default, with the notice not yet shown', () => {
    expect(consentOf({}, folder())).toEqual({ enabled: true, reason: 'default', noticeShown: false });
  });

  it.each([['0'], ['false'], ['off'], ['OFF']])('OARS_TELEMETRY=%s turns it off', (value) => {
    expect(consentOf({ OARS_TELEMETRY: value }, folder())).toMatchObject({ enabled: false, reason: 'OARS_TELEMETRY' });
  });

  it('leaves it on for an OARS_TELEMETRY value that does not say off', () => {
    expect(consentOf({ OARS_TELEMETRY: '1' }, folder()).enabled).toBe(true);
  });

  it.each([['1'], ['true']])('DO_NOT_TRACK=%s turns it off', (value) => {
    expect(consentOf({ DO_NOT_TRACK: value }, folder())).toMatchObject({ enabled: false, reason: 'DO_NOT_TRACK' });
  });

  it('leaves it on for DO_NOT_TRACK=0', () => {
    expect(consentOf({ DO_NOT_TRACK: '0' }, folder()).enabled).toBe(true);
  });

  it('follows the saved setting, and the environment wins over a saved on', () => {
    const dir = folder();
    setEnabled(dir, false);
    expect(consentOf({}, dir)).toMatchObject({ enabled: false, reason: 'setting' });
    setEnabled(dir, true);
    expect(consentOf({}, dir)).toMatchObject({ enabled: true, reason: 'setting' });
    expect(consentOf({ OARS_TELEMETRY: '0' }, dir)).toMatchObject({ enabled: false, reason: 'OARS_TELEMETRY' });
  });

  it('treats a settings file that is not ours as no setting', () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    writeFileSync(spoolPaths(dir).settings, '{not json');
    expect(consentOf({}, dir)).toEqual({ enabled: true, reason: 'default', noticeShown: false });
    writeFileSync(spoolPaths(dir).settings, '[1]');
    expect(consentOf({}, dir).enabled).toBe(true);
  });
});

describe('the notice', () => {
  it('is recorded as shown, once', () => {
    const dir = folder();
    expect(markNoticeShown(dir, () => Date.parse('2026-11-06T10:00:00Z'))).toBe(true);
    expect(consentOf({}, dir).noticeShown).toBe(true);
  });

  it('is not claimed as shown when the folder cannot be written', () => {
    const dir = folder();
    mkdirSync(join(dir, '..'), { recursive: true });
    writeFileSync(dir, 'a file where the folder should be');
    expect(markNoticeShown(dir, Date.now)).toBe(false);
  });

  it('keeps the saved on or off when it is marked shown', () => {
    const dir = folder();
    setEnabled(dir, false);
    markNoticeShown(dir, Date.now);
    expect(consentOf({}, dir)).toMatchObject({ enabled: false, noticeShown: true });
  });

  it('says what is recorded, what is never recorded, what is sent and where, and every switch', () => {
    for (const phrase of ['flag names', 'install id', 'oars version', 'never', 'Many Oars pool', 'pool server in OARS_POOL_URL', 'oars telemetry show', 'oars telemetry off', 'OARS_TELEMETRY=0', 'DO_NOT_TRACK=1']) expect(NOTICE).toContain(phrase);
  });
});

describe('telemetrySendAllowed: the check the sender calls', () => {
  it('refuses before the notice was shown, even though recording is on', () => {
    expect(telemetrySendAllowed({}, folder())).toBe(false);
  });

  it('allows once the notice was shown and nothing turns it off', () => {
    const dir = folder();
    markNoticeShown(dir, Date.now);
    expect(telemetrySendAllowed({}, dir)).toBe(true);
  });

  it.each([[{ OARS_TELEMETRY: '0' }], [{ DO_NOT_TRACK: '1' }]])('refuses under %j after the notice', (env) => {
    const dir = folder();
    markNoticeShown(dir, Date.now);
    expect(telemetrySendAllowed(env, dir)).toBe(false);
  });

  it('refuses after `off`', () => {
    const dir = folder();
    markNoticeShown(dir, Date.now);
    setEnabled(dir, false);
    expect(telemetrySendAllowed({}, dir)).toBe(false);
  });
});
