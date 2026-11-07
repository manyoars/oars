// The one way a part of oars other than `run()` records an event: it checks the switches, passes the closed schema through `recordEvent`, and never throws,
// so no command's exit code or output can depend on it.
import { consentOf } from './consent.js';
import { recordEvent, type TelemetryRuntime } from './record.js';

/** What recording needs from a run: where the folder is, the environment's switches, the version, and the clock. */
export interface Emitter {
  env: NodeJS.ProcessEnv;
  telemetry?: TelemetryRuntime | undefined;
  version: string;
  now: () => number;
}

/** Whether this run records at all: a folder is set and consent is on. A caller that must do work to build an event asks first, so an opt-out pays nothing. */
export const recordsEvents = (emitter: Emitter): boolean => {
  try {
    return emitter.telemetry !== undefined && consentOf(emitter.env, emitter.telemetry.dir).enabled;
  } catch {
    return false;
  }
};

export const emitEvent = (emitter: Emitter, type: string, fields: object): void => {
  try {
    const runtime = emitter.telemetry;
    if (runtime === undefined || !consentOf(emitter.env, runtime.dir).enabled) return;
    recordEvent({ ...runtime, version: emitter.version, now: emitter.now }, type, fields);
  } catch {
    // Telemetry is never allowed to change what a command does.
  }
};
