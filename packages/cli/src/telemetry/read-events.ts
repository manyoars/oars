// The spool's events read back as typed values, by type: for the nightly figures that sum earlier events and for the tests that check what was written.
// A line that is not an event is left out.
import { readSpool } from './spool.js';

export interface SpoolEvent {
  type: string;
  at: string;
  data: { [field: string]: unknown };
}

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const eventOf = (line: string): SpoolEvent | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed) && typeof parsed.type === 'string' && typeof parsed.at === 'string' && isRecord(parsed.data)) return { type: parsed.type, at: parsed.at, data: parsed.data };
  } catch {
    // Not JSON: not an event.
  }
  return undefined;
};

/** Every spooled event, oldest first, or only those of `type`. */
export const spoolEvents = (dir: string, type?: string): SpoolEvent[] => readSpool(dir).flatMap((line) => eventOf(line) ?? []).filter((event) => type === undefined || event.type === type);
