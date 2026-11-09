// What `run()` tells telemetry about a command: its path and its flag names, read from the program's own definitions (the names the CLI declared,
// never anything typed after them), the notice, and the event.
import type { Command } from 'commander';
import type { RunDeps } from '../cli.js';
import type { ExitCode } from '../errors.js';
import { consentOf, markNoticeShown, NOTICE } from './consent.js';
import { recordEvent } from './record.js';
import { startDailySend } from './send.js';
import { errorClassOf } from './schema.js';

export interface Observed {
  /** The command path, such as `['pool', 'fetch']`; empty when no command ran (`--help`, `--version`, a usage error). */
  path: string[];
  /** The long names (as commander keys them) of the options given on the command line. */
  flags: string[];
}

const pathOf = (command: Command): string[] => {
  const names: string[] = [];
  let step = command;
  // The root program has no parent and is not part of the path.
  while (step.parent !== null) {
    names.unshift(step.name());
    step = step.parent;
  }
  return names;
};

/** Called by commander just before an action runs. */
export const observeCommand = (observed: Observed, action: Command): void => {
  observed.path = pathOf(action);
  const given = action.optsWithGlobals();
  observed.flags = Object.keys(given).filter((key) => action.getOptionValueSourceWithGlobals(key) === 'cli');
};

export const isHook = (argv: string[], observed: Observed): boolean => {
  const gateHook = (words: string[]): boolean => words[0] === 'gate' && words[1] === 'hook';
  return gateHook(observed.path) || gateHook(argv);
};

/** Prints the notice on the first run that is not a hook, then records the event. Never throws and never changes what the command did. */
export const finishTelemetry = (deps: RunDeps, argv: string[], observed: Observed, startedAt: number, exit: ExitCode): void => {
  try {
    const runtime = deps.telemetry;
    if (runtime === undefined) return;
    const consent = consentOf(deps.env, runtime.dir);
    if (!consent.enabled) return;
    const context = { ...runtime, version: deps.version, now: deps.now };
    if (!consent.noticeShown && !isHook(argv, observed) && markNoticeShown(runtime.dir, deps.now)) {
      deps.io.stderr(`${NOTICE}\n`);
      // Once per install: the notice is shown once, and nothing is recorded or sent from a folder that could not claim it.
      recordEvent(context, 'first-run', {});
    }
    const errorClass = errorClassOf(exit);
    recordEvent(context, 'command', {
      path: observed.path,
      flags: observed.flags,
      durationMs: Math.max(0, deps.now() - startedAt),
      exitCode: exit,
      ...(errorClass === undefined ? {} : { errorClass }),
    });
    // Never from a hook: a hook has a time budget, and the send is for the detached sender and the commands a person runs.
    if (!isHook(argv, observed)) startDailySend(runtime, deps.env, deps.now());
  } catch {
    // Telemetry is never allowed to change what a command does.
  }
};
