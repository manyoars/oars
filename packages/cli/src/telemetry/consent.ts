// Whether telemetry records and may send, and the one-time notice. The off switches are `oars telemetry off` (a saved setting), `OARS_TELEMETRY=0`, and
// `DO_NOT_TRACK=1`, and a machine whose time zone is in the EU, the EEA, or the UK (`region.ts`), which no switch overrides; the environment wins over a saved `on`. `telemetrySendAllowed` is the check the sender must call before any byte leaves.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isClosedZone, machineZone } from './region.js';
import { spoolPaths } from './spool.js';

/** The version of the notice below. `markNoticeShown` stores it and each batch is stamped with the stored version; raise it whenever the notice changes in meaning. */
export const NOTICE_VERSION = 2;

/** Printed once on stderr, on the first run that is not a hook; also what `oars telemetry on` prints. */
export const NOTICE = [
  'oars records how it is used, on this machine: one event per command with its path, flag names (never their values), how long it took, the exit code, and the class of any error; one per hook fire, recall, deposit, and fetch, as counts and closed words (which hook, how long, hit or miss, how many bytes, the harness name and version and the model name, how many sessions a deposit counted and how many each gate kept out, never which); each with a random install id, the oars version, the OS, and the time. Each time the background sender runs, at most about once an hour, it also records counts and sizes of the session store, the lists of harness versions and model names it holds, and what the run cost. Events are sent in a batch at most once a day. A crash is recorded as the error\'s class and a hash of its stack (never its message). Each pool deposit records, per batch, which fields it held and how many bytes each took, and each send (a wire-send event) its HTTP status, the pool\'s refusal code, and its size. It also records one event on the first run with whether it ran in CI and how this copy was installed, as closed words; whether each command ran in CI, as a closed word; and the covenant version each time the covenant screen is shown at a terminal.',
  'It never records session content, prompts, file paths, URLs, arguments, or anything you typed. oars sends the events in batches to the pool server in OARS_POOL_URL, else to the Many Oars pool (pool.manyoars.com, which is live). Many Oars Co. may license and sell Usage Data. oars sends no telemetry from a machine whose time zone is in the EU, the EEA, or the UK.',
  'See exactly what is kept: oars telemetry show. Turn it off: oars telemetry off, or set OARS_TELEMETRY=0 or DO_NOT_TRACK=1. More: docs/telemetry.md.',
].join('\n');

export type Reason = 'default' | 'setting' | 'OARS_TELEMETRY' | 'DO_NOT_TRACK' | 'region';

export interface Consent {
  enabled: boolean;
  /** Which switch decided `enabled`. */
  reason: Reason;
  /** The notice was printed (or `on` was run) on this install. */
  noticeShown: boolean;
}

interface Settings {
  enabled?: boolean;
  noticeShownAt?: string;
  noticeVersion?: number;
}

const readSettings = (dir: string): Settings => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(spoolPaths(dir).settings, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const enabled: unknown = Reflect.get(parsed, 'enabled');
    const shown: unknown = Reflect.get(parsed, 'noticeShownAt');
    const version: unknown = Reflect.get(parsed, 'noticeVersion');
    return {
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(typeof shown === 'string' ? { noticeShownAt: shown } : {}),
      ...(typeof version === 'number' ? { noticeVersion: version } : {}),
    };
  } catch {
    return {};
  }
};

/** Write to a sibling and rename over, so a crash leaves the old settings or the new, never half. */
const writeSettings = (dir: string, settings: Settings): void => {
  const { settings: path } = spoolPaths(dir);
  mkdirSync(dir, { recursive: true });
  const scratch = `${path}.tmp`;
  writeFileSync(scratch, `${JSON.stringify(settings)}\n`);
  renameSync(scratch, path);
};

const OFF_WORDS = new Set(['0', 'false', 'off', 'no']);
const DO_NOT_TRACK_WORDS = new Set(['1', 'true']);

export const consentOf = (env: NodeJS.ProcessEnv, dir: string, zone: string | undefined = machineZone()): Consent => {
  const settings = readSettings(dir);
  // An install that saw an older notice (no stored version, or another one) has not seen this one: it sees it again, and sends nothing until then.
  const noticeShown = settings.noticeShownAt !== undefined && settings.noticeVersion === NOTICE_VERSION;
  // First, so that no setting or `oars telemetry on` turns it back on in a closed region.
  if (isClosedZone(zone)) return { enabled: false, reason: 'region', noticeShown };
  if (OFF_WORDS.has((env.OARS_TELEMETRY ?? '').toLowerCase())) return { enabled: false, reason: 'OARS_TELEMETRY', noticeShown };
  if (DO_NOT_TRACK_WORDS.has((env.DO_NOT_TRACK ?? '').toLowerCase())) return { enabled: false, reason: 'DO_NOT_TRACK', noticeShown };
  if (settings.enabled !== undefined) return { enabled: settings.enabled, reason: 'setting', noticeShown };
  return { enabled: true, reason: 'default', noticeShown };
};

/** Saves `on` or `off`. Throws when the folder cannot be written: the command that asked reports it. */
export const setEnabled = (dir: string, enabled: boolean): void => {
  writeSettings(dir, { ...readSettings(dir), enabled });
};

/** Records that the notice was shown; `false` when it could not be recorded (nothing is recorded or sent from a folder that cannot be written). */
export const markNoticeShown = (dir: string, now: () => number): boolean => {
  try {
    writeSettings(dir, { ...readSettings(dir), noticeShownAt: new Date(now()).toISOString(), noticeVersion: NOTICE_VERSION });
    return true;
  } catch {
    return false;
  }
};

/** The notice version this install was shown, or `undefined` when none (or an unreadable file). */
export const shownNoticeVersion = (dir: string): number | undefined => readSettings(dir).noticeVersion;

/** Whether the sender (t875) may send: telemetry on, and the notice shown. Off, or notice not yet shown, means nothing sends. */
export const telemetrySendAllowed = (env: NodeJS.ProcessEnv, dir: string, zone: string | undefined = machineZone()): boolean => {
  const consent = consentOf(env, dir, zone);
  return consent.enabled && consent.noticeShown;
};
