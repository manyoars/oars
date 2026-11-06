// Whether telemetry records and may send, and the one-time notice. The off switches are `oars telemetry off` (a saved setting), `OARS_TELEMETRY=0`, and
// `DO_NOT_TRACK=1`; the environment wins over a saved `on`. `telemetrySendAllowed` is the check the sender must call before any byte leaves.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spoolPaths } from './spool.js';

/** Printed once on stderr, on the first run that is not a hook; also what `oars telemetry on` prints. */
export const NOTICE = [
  'oars records how it is used, on this machine: which command ran, flag names (never their values), how long it took, the exit code, and the class of any error.',
  'It never records session content, prompts, file paths, URLs, arguments, or anything you typed. The events are sent in batches, and only to a pool server you configure; with none configured they stay in the spool.',
  'See exactly what is kept: oars telemetry show. Turn it off: oars telemetry off, or set OARS_TELEMETRY=0 or DO_NOT_TRACK=1. More: docs/telemetry.md.',
].join('\n');

export type Reason = 'default' | 'setting' | 'OARS_TELEMETRY' | 'DO_NOT_TRACK';

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
}

const readSettings = (dir: string): Settings => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(spoolPaths(dir).settings, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const enabled: unknown = Reflect.get(parsed, 'enabled');
    const shown: unknown = Reflect.get(parsed, 'noticeShownAt');
    return { ...(typeof enabled === 'boolean' ? { enabled } : {}), ...(typeof shown === 'string' ? { noticeShownAt: shown } : {}) };
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

export const consentOf = (env: NodeJS.ProcessEnv, dir: string): Consent => {
  const settings = readSettings(dir);
  const noticeShown = settings.noticeShownAt !== undefined;
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
    writeSettings(dir, { ...readSettings(dir), noticeShownAt: new Date(now()).toISOString() });
    return true;
  } catch {
    return false;
  }
};

/** Whether the sender (t875) may send: telemetry on, and the notice shown. Off, or notice not yet shown, means nothing sends. */
export const telemetrySendAllowed = (env: NodeJS.ProcessEnv, dir: string): boolean => {
  const consent = consentOf(env, dir);
  return consent.enabled && consent.noticeShown;
};
