// The `oars gate` command group's bodies: each returns the `--json` document and the text a human sees.
import { readFile } from 'node:fs/promises';
import type { Outcome } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import type { SessionsDeps } from '../sessions/command.js';
import type { InstallRuntime } from '../sessions/install.js';
import type { SessionsRuntime } from '../sessions/store.js';
import { crossingsPath } from './hook.js';
import { COMMAND, EVENT, installGateHook, MATCHER, uninstallGateHook } from './install.js';
import { loadIndex } from './novelty.js';
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
  if (!rows.some((row) => row.kind === 'run' || row.kind === 'crossing')) {
    throw new CliError('No crossings have been recorded yet: run `oars gate install` to record them as they happen, or `oars gate replay --allow <folder>` to find the ones already in your logs.', ExitCode.USAGE, 'usage');
  }
  const report = reportOf(rows);
  return { document: report, text: formatReport(report) };
};

const installOf = (deps: SessionsDeps): InstallRuntime => {
  if (deps.install === undefined) throw new CliError('Hook install is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  return deps.install;
};

/** User scope only: the one place the harness reads for every project, and the one place this command ever writes. */
export const gateInstall = async (deps: SessionsDeps): Promise<Outcome> => {
  const file = installOf(deps).userSettings;
  const result = await installGateHook(file);
  const lines = [
    result.changed
      ? `Installed the gate hook in ${file}: ${EVENT} for ${MATCHER}, running \`${COMMAND}\`. It records each crossing in crossings.jsonl and prints nothing; it never allows, denies, or changes a call.`
      : `The gate hook is already installed in ${file}; nothing was changed.`,
  ];
  // A record with no kept index cannot tell what is new without a scan the hook must not do, so it reads `not-read` until a replay seeds the index.
  const storeDir = deps.sessions?.storeDir;
  if (storeDir !== undefined && (await loadIndex(storeDir, crossingsPath(storeDir))).state === 'unseeded') {
    lines.push('Run `oars gate replay --allow <folder>` once to seed the novelty index; until then the hook records novelty as not-read.');
  }
  return { document: { ok: true, file, changed: result.changed, event: EVENT, matcher: MATCHER, command: COMMAND }, text: lines.join('\n') };
};

export const gateUninstall = async (deps: SessionsDeps): Promise<Outcome> => {
  const result = await uninstallGateHook(installOf(deps).userSettings);
  const text = result.removed ? `Removed the gate hook from ${result.file}; other settings and hooks are untouched, and crossings.jsonl stays.` : `No gate hook in ${result.file}.`;
  return { document: { ok: true, ...result }, text };
};
