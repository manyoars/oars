// Records one event: closed schema, then the spool. It never throws and returns nothing, so a command's exit code and output cannot depend on it.
import { SCHEMA_VERSION, sanitize } from './schema.js';
import { appendLine, installId } from './spool.js';

/** Where telemetry keeps its folder; absent from a run, nothing is recorded. */
export interface TelemetryRuntime {
  /** `<config>/oars/telemetry`. */
  dir: string;
  platform: NodeJS.Platform;
  /** Starts the detached send (`spawnDetachedSend`); only `main.ts` supplies it, so a run without one never sends. */
  spawnSend?: (dir: string) => void;
}

export interface RecordContext extends TelemetryRuntime {
  /** The CLI's version. */
  version: string;
  /** Epoch milliseconds. */
  now: () => number;
  /** The spool's byte cap per file; absent means `SPOOL_CAP_BYTES`. */
  capBytes?: number;
}

const OS = ['win32', 'darwin', 'linux'];
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,32})?$/;

export const recordEvent = (context: RecordContext, type: string, fields: object): void => {
  try {
    const checked = sanitize(type, fields);
    if (checked === undefined) return;
    const event = {
      v: SCHEMA_VERSION,
      id: installId(context.dir),
      at: new Date(context.now()).toISOString(),
      type,
      cli: VERSION.test(context.version) ? context.version : 'unknown',
      os: OS.includes(context.platform) ? context.platform : 'other',
      ...(checked.dropped > 0 ? { dropped: checked.dropped } : {}),
      data: checked.data,
    };
    appendLine(context.dir, JSON.stringify(event), context.capBytes);
  } catch {
    // Telemetry is never allowed to change what a command does.
  }
};
