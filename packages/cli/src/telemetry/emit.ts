// How a working path hands telemetry one event: one call, consent checked, never throwing, so the line a command or hook carries is the whole cost to its caller.
import { consentOf } from './consent.js';
import { recordEvent, type TelemetryRuntime } from './record.js';

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

export const emitFor =
  ({ env, telemetry, version, now }: EmitContext): Emit =>
  (type, fields) => {
    try {
      if (telemetry === undefined || !consentOf(env, telemetry.dir).enabled) return;
      recordEvent({ ...telemetry, version: version(), now }, type, fields);
    } catch {
      // Telemetry is never allowed to change what a command or hook does.
    }
  };

/** An emitter that records nothing, for a caller built without telemetry. */
export const noEmit: Emit = () => undefined;

/** The emitter for a CLI run: the run's environment, telemetry folder, version, and clock. */
export const emitOf = (deps: { env: NodeJS.ProcessEnv; telemetry?: TelemetryRuntime | undefined; version: string; now: () => number }): Emit =>
  emitFor({ env: deps.env, telemetry: deps.telemetry, version: () => deps.version, now: deps.now });
