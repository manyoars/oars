// The `oars gate` command group's bodies: each returns the `--json` document and the text a human sees.
import { readFile } from 'node:fs/promises';
import type { Outcome } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import type { SessionsDeps } from '../sessions/command.js';
import type { SessionsRuntime } from '../sessions/store.js';
import { parseRows } from './record.js';
import type { RegistryReader } from './registry.js';
import { formatReport, reportOf } from './report.js';
import { crossingsFile, replay } from './replay.js';

const runtimeOf = (deps: SessionsDeps): SessionsRuntime => {
  if (deps.sessions === undefined) throw new CliError('The session store is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  return deps.sessions;
};

/** Reads local logs only; a `registry` reader is passed solely by `--registry-state`. */
export const gateReplay = async (deps: SessionsDeps, options: { allow: string[]; registry?: RegistryReader }): Promise<Outcome> => {
  const done = await replay(runtimeOf(deps), { allow: options.allow, now: deps.now, ...(options.registry === undefined ? {} : { registry: options.registry }) });
  return { document: { ok: true, run: done.run, file: done.file }, text: done.text };
};

export const gateReport = async (deps: SessionsDeps): Promise<Outcome> => {
  const text = await readFile(crossingsFile(runtimeOf(deps).storeDir), 'utf8').catch(() => '');
  const rows = parseRows(text);
  if (!rows.some((row) => row.kind === 'run')) throw new CliError('No replay has been written yet: run `oars gate replay --allow <folder>` first.', ExitCode.USAGE, 'usage');
  const report = reportOf(rows);
  return { document: report, text: formatReport(report) };
};
