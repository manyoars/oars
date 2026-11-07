// `oars telemetry report`: what telemetry measured about the user's own use, from the spool on this machine, beside the fleet's number for the same cell when a pool server is configured and answers.
// The own numbers need no server and no account. The fleet read is a plain GET that carries nothing of the user's: no credential, no install id, no event. Nothing here writes the spool.
import { CliError } from '../errors.js';
import { cellKey, measuresOf, percentile, WINDOWS, type Kind, type Measure } from './measures.js';

const DAY_MS = 86_400_000;
const FLEET_TIMEOUT_MS = 10_000;

/** The fleet's number for one cell: percentiles of the fleet's latency, or the median install's rate. */
export interface FleetNumbers {
  p50: number;
  p95?: number;
}

export interface FleetCell extends FleetNumbers {
  metric: string;
  dimension: Measure['dimension'];
  value: string;
  kind: Kind;
}

export interface OwnCell {
  metric: string;
  dimension: Measure['dimension'];
  value: string;
  kind: Kind;
  /** Observations in the window. */
  n: number;
  p50?: number;
  p95?: number;
  /** For a rate: the share of the user's observations that were a yes. */
  rate?: number;
  fleet?: FleetNumbers;
}

export interface StoreSnapshot {
  at: string;
  readFailed: boolean;
  sessions?: number;
  subagents?: number;
  skeletons?: number;
  unparseable?: number;
  verifyChecked?: number;
  verifyFailed?: number;
  rawBytes?: number;
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);
const fieldOf = (value: unknown, key: string): unknown => (isObject(value) ? Reflect.get(value, key) : undefined);

interface Parsed {
  at: number;
  event: unknown;
}

/** The spool's events that parse and carry a time. A line that is not an event is skipped; the spool is the user's file and may hold anything. */
const eventsOf = (lines: readonly string[]): Parsed[] =>
  lines.flatMap((line) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    const raw = fieldOf(event, 'at');
    const at = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    return Number.isNaN(at) ? [] : [{ at, event }];
  });

const within = (parsed: readonly Parsed[], now: number, days: number): Parsed[] => parsed.filter(({ at }) => at >= now - days * DAY_MS && at <= now + DAY_MS);

/** The user's own cells over the last `days`, ordered by metric and then value. */
export const ownCells = (lines: readonly string[], now: number, days: number): OwnCell[] => {
  const groups = new Map<string, { head: Measure; xs: number[] }>();
  for (const { event } of within(eventsOf(lines), now, days)) {
    for (const measure of measuresOf(event)) {
      const key = cellKey(measure);
      const group = groups.get(key) ?? { head: measure, xs: [] };
      group.xs.push(measure.x);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .map(({ head, xs }): OwnCell => {
      const { metric, dimension, value, kind } = head;
      if (kind === 'rate') return { metric, dimension, value, kind, n: xs.length, rate: xs.reduce((sum, x) => sum + x, 0) / xs.length };
      return { metric, dimension, value, kind, n: xs.length, p50: percentile(xs, 0.5), p95: percentile(xs, 0.95) };
    })
    .sort((a, b) => a.metric.localeCompare(b.metric) || a.value.localeCompare(b.value));
};

const COUNTS = ['sessions', 'subagents', 'skeletons', 'unparseable', 'verifyChecked', 'verifyFailed', 'rawBytes'] as const;

/** The newest store-health snapshot in the window: its counts as the nightly recorded them. */
export const latestStore = (lines: readonly string[], now: number, days: number): StoreSnapshot | undefined => {
  const newest = within(eventsOf(lines), now, days)
    .filter(({ event }) => fieldOf(event, 'type') === 'store-health')
    .sort((a, b) => b.at - a.at)[0];
  if (newest === undefined) return undefined;
  const data = fieldOf(newest.event, 'data');
  const field = (name: string): unknown => fieldOf(data, name);
  const snapshot: StoreSnapshot = { at: new Date(newest.at).toISOString(), readFailed: field('readFailed') === 1 };
  for (const name of COUNTS) {
    const found = field(name);
    if (typeof found === 'number' && Number.isSafeInteger(found) && found >= 0) snapshot[name] = found;
  }
  return snapshot;
};

/** The user's cells with the fleet's number put on each cell the fleet serves; the fleet is `undefined` when no read answered. */
export const besideFleet = (own: readonly OwnCell[], fleet: readonly FleetCell[] | undefined): OwnCell[] =>
  own.map((cell) => {
    const match = fleet?.find((one) => one.metric === cell.metric && one.dimension === cell.dimension && one.value === cell.value);
    if (match === undefined) return cell;
    return { ...cell, fleet: match.p95 === undefined ? { p50: match.p50 } : { p50: match.p50, p95: match.p95 } };
  });

export interface FleetWindow {
  days: number;
  cells: FleetCell[];
}

export type FleetRead =
  | { status: 'not-configured' }
  | { status: 'unavailable'; server?: string; reason: string }
  | { status: 'answered'; server: string; asOf: string; floor: number; windows: FleetWindow[] };

const fleetCellOf = (raw: unknown): FleetCell | undefined => {
  const metric = fieldOf(raw, 'metric');
  const dimension = fieldOf(raw, 'dimension');
  const value = fieldOf(raw, 'value');
  const kind = fieldOf(raw, 'kind');
  const p50 = fieldOf(raw, 'p50');
  const p95 = fieldOf(raw, 'p95');
  if (typeof metric !== 'string' || typeof value !== 'string' || typeof p50 !== 'number') return undefined;
  if (dimension !== 'harnessVersion' && dimension !== 'cli') return undefined;
  if (kind !== 'latency' && kind !== 'rate') return undefined;
  return { metric, dimension, value, kind, p50, ...(typeof p95 === 'number' ? { p95 } : {}) };
};

/** The answer as a fleet read, or undefined when it is not one; a cell that is not a cell is left out. */
const fleetOf = (server: string, body: unknown): FleetRead | undefined => {
  const asOf = fieldOf(body, 'asOf');
  const floor = fieldOf(body, 'floor');
  const windows = fieldOf(body, 'windows');
  if (typeof asOf !== 'string' || typeof floor !== 'number' || !Array.isArray(windows)) return undefined;
  const read: FleetWindow[] = [];
  for (const window of windows) {
    const days = fieldOf(window, 'days');
    const cells = fieldOf(window, 'cells');
    if (typeof days !== 'number' || !Array.isArray(cells)) return undefined;
    read.push({ days, cells: cells.flatMap((cell) => fleetCellOf(cell) ?? []) });
  }
  return { status: 'answered', server, asOf, floor, windows: read };
};

/**
 * The fleet's numbers from the pool server in `OARS_POOL_URL`, or why there are none. The request is a bare GET: it names no install and sends no credential, cookie, or event.
 * Anything wrong, a refusal, a timeout, or an answer of the wrong shape, comes back as `unavailable`; it never fails the report.
 */
export const readFleet = async (env: NodeJS.ProcessEnv): Promise<FleetRead> => {
  if ((env.OARS_POOL_URL ?? '') === '') return { status: 'not-configured' };
  let server: string;
  try {
    const { poolServer } = await import('../sessions/pool-command.js');
    server = poolServer(env, 'telemetry');
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof CliError ? error.message : 'the setting is not a usable server' };
  }
  try {
    const reply = await fetch(`${server}/v1/telemetry/fleet`, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(FLEET_TIMEOUT_MS) });
    if (!reply.ok) return { status: 'unavailable', server, reason: `HTTP ${String(reply.status)}` };
    const body: unknown = await reply.json().catch(() => undefined);
    return fleetOf(server, body) ?? { status: 'unavailable', server, reason: 'the answer is not a fleet read' };
  } catch {
    return { status: 'unavailable', server, reason: 'it could not be reached' };
  }
};

const percent = (rate: number): string => `${String(Math.round(rate * 100))}%`;

const numbersOf = (cell: { kind: Kind; p50?: number; p95?: number; rate?: number }): string =>
  cell.kind === 'rate' ? percent(cell.rate ?? 0) : `p50 ${String(cell.p50 ?? 0)} ms, p95 ${String(cell.p95 ?? 0)} ms`;

const fleetNumbers = (cell: OwnCell, fleet: FleetNumbers): string => (cell.kind === 'rate' ? `the fleet's median install: ${percent(fleet.p50)}` : `fleet p50 ${String(fleet.p50)} ms, p95 ${String(fleet.p95 ?? 0)} ms`);

const cellLines = (cell: OwnCell, answered: boolean, floor: number): string[] => {
  const own = cell.kind === 'rate' ? `your rate ${percent(cell.rate ?? 0)}` : numbersOf(cell);
  const lines = [`  ${cell.metric} (${cell.dimension} ${cell.value})  n=${String(cell.n)}  ${own}`];
  if (cell.fleet !== undefined) lines.push(`    ${fleetNumbers(cell, cell.fleet)}`);
  else if (answered) lines.push(`    fleet: not served (fewer than ${String(floor)} installs report this)`);
  return lines;
};

const storeLine = (store: StoreSnapshot): string => {
  if (store.readFailed) return `Store health, as of ${store.at}: the store could not be read.`;
  const parts = COUNTS.flatMap((name) => (store[name] === undefined ? [] : [`${name} ${String(store[name])}`]));
  return `Store health, as of ${store.at}: ${parts.join(', ')}.`;
};

export interface Report {
  windows: { days: number; cells: OwnCell[] }[];
  store: StoreSnapshot | undefined;
  fleet: FleetRead;
}

export const reportOf = (lines: readonly string[], now: number, fleet: FleetRead): Report => ({
  windows: WINDOWS.map((days) => {
    const window = fleet.status === 'answered' ? fleet.windows.find((one) => one.days === days) : undefined;
    return { days, cells: besideFleet(ownCells(lines, now, days), window?.cells) };
  }),
  store: latestStore(lines, now, Math.max(...WINDOWS)),
  fleet,
});

export const textOf = (report: Report, dir: string): string => {
  const { fleet } = report;
  const answered = fleet.status === 'answered';
  const floor = fleet.status === 'answered' ? fleet.floor : 0;
  const out = [`Your telemetry, from the spool in ${dir}.`];
  if (report.windows.every((window) => window.cells.length === 0) && report.store === undefined) out.push('Nothing is measured in the spool yet: the hooks and nightly task record as they run.');
  for (const window of report.windows) {
    if (window.cells.length === 0) continue;
    out.push('', `Last ${String(window.days)} days`);
    for (const cell of window.cells) out.push(...cellLines(cell, answered, floor));
  }
  if (report.store !== undefined) out.push('', storeLine(report.store));
  out.push('');
  if (fleet.status === 'not-configured') out.push('No pool server is configured (OARS_POOL_URL), so these are your numbers only.');
  else if (fleet.status === 'unavailable') out.push(`The pool server${fleet.server === undefined ? '' : ` at ${fleet.server}`} did not give a fleet read (${fleet.reason}), so these are your numbers only.`);
  else out.push(`Fleet numbers are as of ${fleet.asOf}, from ${fleet.server}: percentiles over installs, served only where at least ${String(fleet.floor)} installs report. The read sent nothing of yours.`);
  return out.join('\n');
};
