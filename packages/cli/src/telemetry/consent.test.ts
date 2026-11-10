import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfigDir } from '../credentials.js';
import { consentOf, markNoticeShown, NOTICE, NOTICE_VERSION, setEnabled, shownNoticeVersion, telemetrySendAllowed } from './consent.js';
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
  it('is not counted as shown for an install that saw an older notice', () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    writeFileSync(spoolPaths(dir).settings, JSON.stringify({ noticeShownAt: '2026-11-01T00:00:00.000Z' }));
    expect(consentOf({}, dir, 'America/New_York').noticeShown).toBe(false);
    expect(telemetrySendAllowed({}, dir, 'America/New_York')).toBe(false);
    expect(shownNoticeVersion(dir)).toBeUndefined();
    markNoticeShown(dir, Date.now);
    expect(telemetrySendAllowed({}, dir, 'America/New_York')).toBe(true);
    expect(shownNoticeVersion(dir)).toBe(NOTICE_VERSION);
  });

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
    for (const phrase of ['flag names', 'hook fire, recall, deposit, and fetch', 'counts and closed words', 'the harness name and version and the model name', 'install id', 'oars version', 'never', 'Many Oars pool', 'pool server in OARS_POOL_URL', 'Each time the background sender runs', 'crash', 'never its message', 'oars telemetry show', 'oars telemetry off', 'OARS_TELEMETRY=0', 'DO_NOT_TRACK=1']) expect(NOTICE).toContain(phrase);
    // The default pool is live (t962), and the notice must not call it undeployed.
    expect(NOTICE).toContain('pool.manyoars.com, which is live');
    expect(NOTICE).not.toContain('not deployed');
    expect(NOTICE).not.toContain('and only there');
    // Only the store snapshot and the run's cost are recorded per sender run: a crash and a deposit's batches are recorded when they happen, and the notice must not say otherwise.
    const perRun = NOTICE.slice(NOTICE.indexOf('Each time the background sender runs'), NOTICE.indexOf('.', NOTICE.indexOf('Each time the background sender runs')) + 1);
    expect(perRun).toBe('Each time the background sender runs, at most about once an hour, it also records counts and sizes of the session store, the lists of harness versions and model names it holds, and what the run cost.');
    expect(NOTICE).toContain('Events are sent in a batch at most once a day.');
    for (const phrase of ['A crash is recorded as the error\'s class and a hash of its stack (never its message).', 'Each pool deposit records, per batch, which fields it held and how many bytes each took', 'a wire-send event', 'the pool\'s refusal code']) expect(NOTICE).toContain(phrase);
  });

  it('names the first-run event, the CI word on each command, and the covenant version the screen is shown for', () => {
    for (const phrase of ['one event on the first run with whether it ran in CI and how this copy was installed, as closed words', 'whether each command ran in CI, as a closed word', 'the covenant version each time the covenant screen is shown at a terminal']) expect(NOTICE).toContain(phrase);
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

const REAL_OPTIONS = Intl.DateTimeFormat().resolvedOptions();
const zoned = (timeZone: string): Intl.ResolvedDateTimeFormatOptions => ({ ...REAL_OPTIONS, timeZone });

describe('closed regions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each(['Europe/Berlin', 'Europe/Paris', 'Europe/London', 'Europe/Oslo', 'Atlantic/Reykjavik', 'Europe/Vaduz', 'Europe/Mariehamn', 'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores', 'Indian/Reunion', 'America/Martinique', 'America/Cayenne', 'Europe/Dublin', 'Atlantic/Jan_Mayen', 'WET', 'CET', 'MET', 'EET'])('is off in %s, even with a saved on and the notice shown', (zone) => {
    const dir = folder();
    setEnabled(dir, true);
    markNoticeShown(dir, Date.now);
    expect(consentOf({}, dir, zone)).toEqual({ enabled: false, reason: 'region', noticeShown: true });
    expect(telemetrySendAllowed({}, dir, zone)).toBe(false);
  });
  it.each(['', 'Etc/Unknown'])('counts a blank zone (%j) as closed', (zone) => {
    expect(consentOf({}, folder(), zone)).toMatchObject({ enabled: false, reason: 'region' });
  });
  it.each(['America/New_York', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'])('is on by default in %s', (zone) => {
    expect(consentOf({}, folder(), zone)).toEqual({ enabled: true, reason: 'default', noticeShown: false });
  });
  it('reads the machine zone by default, and a runtime that cannot say is closed', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    spy.mockImplementation(() => zoned('Europe/Madrid'));
    expect(consentOf({}, folder()).reason).toBe('region');
    spy.mockImplementation(() => {
      throw new Error('no zone');
    });
    expect(consentOf({}, folder()).reason).toBe('region');
    spy.mockImplementation(() => zoned('America/New_York'));
    expect(consentOf({}, folder()).reason).toBe('default');
  });
});

describe('the first-run notice', () => {
  it('states the covenant sentences word for word, and has a version', () => {
    expect(NOTICE).toContain('Many Oars Co. may license and sell Usage Data. oars sends no telemetry from a machine whose time zone is in the EU, the EEA, or the UK.');
    expect(NOTICE).not.toContain('and nowhere else');
    expect(NOTICE_VERSION).toBe(2);
  });
});
