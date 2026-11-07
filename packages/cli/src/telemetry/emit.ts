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

export const emitEvent = (emitter: Emitter, type: string, fields: object): void => {
  try {
    const runtime = emitter.telemetry;
    if (runtime === undefined || !consentOf(emitter.env, runtime.dir).enabled) return;
    recordEvent({ ...runtime, version: emitter.version, now: emitter.now }, type, fields);
  } catch {
    // Telemetry is never allowed to change what a command does.
  }
};
