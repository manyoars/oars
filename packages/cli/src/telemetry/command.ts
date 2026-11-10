// `oars telemetry status|on|off|show`.
import { statSync } from 'node:fs';
import type { Outcome, RunDeps } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { consentOf, markNoticeShown, NOTICE, setEnabled, type Consent } from './consent.js';
import { recordFirstRun } from './observe.js';
import type { TelemetryRuntime } from './record.js';
import { readFleet, reportOf, textOf } from './report.js';
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
  region: 'off in the EU, the EEA, and the UK',
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
    'Events are sent to the pool server in OARS_POOL_URL, else to the Many Oars pool (pool.manyoars.com, which is live), and only while telemetry is on and the notice has been shown.',
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
  const runtime = runtimeOf(deps);
  const { dir } = runtime;
  const first = !consentOf(deps.env, dir).noticeShown;
  save(dir, true);
  // Running `on` is the notice: it is printed here and recorded as shown, so the run's own check finds it shown and sends the `first-run` event from here.
  const marked = markNoticeShown(dir, deps.now);
  const consent = consentOf(deps.env, dir);
  if (first && marked && consent.enabled) recordFirstRun(deps, runtime);
  const override = consent.enabled ? '' : consent.reason === 'region' ? `\nIt stays off: ${REASONS.region}.` : `\nIt stays off in this shell: ${consent.reason} is set.`;
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

/** The user's own numbers from the spool, and the fleet's beside them when a pool server is configured and answers (docs/telemetry.md, "The report"). It writes nothing. */
export const telemetryReport = async (deps: RunDeps): Promise<Outcome> => {
  const { dir } = runtimeOf(deps);
  const report = reportOf(readSpool(dir), deps.now(), await readFleet(deps.env));
  return { document: { ok: true, step: STEP, ...report }, text: textOf(report, dir) };
};
