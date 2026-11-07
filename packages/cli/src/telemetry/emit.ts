// The one way a part of oars records an event: it checks the switches, passes the closed schema through `recordEvent`, and never throws,
// so no command's exit code or output can depend on it. A working path holds one `Emit`: one call, consent checked, so the line it carries is the whole cost to its caller.
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
    // Telemetry is never allowed to change what a command or hook does.
  }
};

/** Records one event of a known type; a no-op when telemetry is off, has no folder, or fails. */
export type Emit = (type: string, fields: object) => void;

export interface EmitContext {
  env: NodeJS.ProcessEnv;
  /** Absent: nothing is recorded. */
  telemetry: TelemetryRuntime | undefined;
  /** Read only when an event is about to be written, so a run with telemetry off never reads it. */
  version: () => string;
  now: () => number;
}

export const emitFor = ({ env, telemetry, version, now }: EmitContext): Emit => {
  const emitter: Emitter = {
    env,
    telemetry,
    // A getter, so `emitEvent` reads the version only after consent says an event will be written.
    get version() {
      return version();
    },
    now,
  };
  return (type, fields) => {
    emitEvent(emitter, type, fields);
  };
};

/** An emitter that records nothing, for a caller built without telemetry. */
export const noEmit: Emit = () => undefined;

/** The emitter for a CLI run: the run's environment, telemetry folder, version, and clock. */
export const emitOf = (deps: { env: NodeJS.ProcessEnv; telemetry?: TelemetryRuntime | undefined; version: string; now: () => number }): Emit =>
  emitFor({ env: deps.env, telemetry: deps.telemetry, version: () => deps.version, now: deps.now });
