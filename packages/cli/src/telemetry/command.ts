// `oars telemetry status|on|off|show`.
import { statSync } from 'node:fs';
import type { Outcome, RunDeps } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { consentOf, markNoticeShown, NOTICE, setEnabled, type Consent } from './consent.js';
import type { TelemetryRuntime } from './record.js';
import { readSpool, spoolPaths } from './spool.js';

const STEP = 'telemetry';

const runtimeOf = (deps: RunDeps): TelemetryRuntime => {
  if (deps.telemetry === undefined) throw new CliError('The telemetry folder is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  return deps.telemetry;
};

const REASONS = {
  default: 'on by default',
  setting: 'by `oars telemetry on` or `off`',
  OARS_TELEMETRY: 'by OARS_TELEMETRY',
  DO_NOT_TRACK: 'by DO_NOT_TRACK',
};

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

const describe = (consent: Consent): string => `Telemetry is ${consent.enabled ? 'on' : 'off'} (${REASONS[consent.reason]}).`;

export const telemetryStatus = (deps: RunDeps): Outcome => {
  const { dir } = runtimeOf(deps);
  const consent = consentOf(deps.env, dir);
  const events = readSpool(dir).length;
  const bytes = sizeOf(spoolPaths(dir).current) + sizeOf(spoolPaths(dir).previous);
  const lines = [
    describe(consent),
    `The notice has ${consent.noticeShown ? '' : 'not '}been shown.`,
    `${String(events)} events (${String(bytes)} bytes) in ${dir}.`,
    'Events are sent to the Many Oars pool or the pool server in OARS_POOL_URL, and only while telemetry is on and the notice has been shown.',
  ];
  return { document: { ok: true, step: STEP, enabled: consent.enabled, reason: consent.reason, noticeShown: consent.noticeShown, events, bytes, dir }, text: lines.join('\n') };
};

const save = (dir: string, enabled: boolean): void => {
  try {
    setEnabled(dir, enabled);
  } catch (error) {
    throw new CliError(`Could not save the telemetry setting in ${dir}: ${error instanceof Error ? error.message : String(error)}`, ExitCode.UNEXPECTED, 'telemetry-setting');
  }
};

export const telemetryOn = (deps: RunDeps): Outcome => {
  const { dir } = runtimeOf(deps);
  save(dir, true);
  // Running `on` is the notice: it is printed here and recorded as shown.
  markNoticeShown(dir, deps.now);
  const consent = consentOf(deps.env, dir);
  const override = consent.enabled ? '' : `\nIt stays off in this shell: ${consent.reason} is set.`;
  return { document: { ok: true, step: STEP, enabled: consent.enabled, reason: consent.reason, notice: NOTICE }, text: `Telemetry is on.\n${NOTICE}${override}` };
};

export const telemetryOff = (deps: RunDeps): Outcome => {
  const { dir } = runtimeOf(deps);
  save(dir, false);
  return {
    document: { ok: true, step: STEP, enabled: false, reason: 'setting' },
    text: `Telemetry is off: nothing more is recorded or sent. What is already in the spool stays until you delete ${dir}.`,
  };
};

const parsed = (line: string): unknown[] => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
};

/** The spool exactly as it is on disk, oldest first, as `pool outbox` prints a batch; the document carries the same events parsed. */
export const telemetryShow = (deps: RunDeps): Outcome => {
  const { dir } = runtimeOf(deps);
  const lines = readSpool(dir);
  return { document: { ok: true, step: STEP, events: lines.flatMap(parsed) }, text: lines.length === 0 ? `The spool is empty (${dir}).` : lines.join('\n') };
};
