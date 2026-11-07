// `oars sessions books --by package`: the per-package counts a field report prints, read from the local store only. A pure function of a
// loaded store and the excluded sessions the A38 scan returns, so the numbers can be rerun by anyone. It prints counts: no rank, share, or comparison.
import { PUBLIC_PACKAGES } from './public-vocabulary.js';
import { resolvePull } from './package-resolve.js';
import { projectStoredPackage } from './projection.js';
import { harnessOf, type ToolObservation } from './schema.js';
import type { Store } from './store.js';
import type { Vocabulary } from './vocab-load.js';

/** The first capture version that records `errorCode`; a failed call captured before it has no class to count. */
export const ERROR_CODE_SINCE = 14;

/** The class of a failed call captured at a version that records classes but names none. */
export const NO_CLASS = 'no class recorded';

const NO_MODEL = 'no model';
const OTHER_MODEL = 'another model';

export interface HarnessModelCount {
  harness: string;
  model: string;
  calls: number;
  failed: number;
}

export interface PackageRow {
  package: string;
  calls: number;
  failed: number;
  sessions: number;
  /** First and last UTC day a counted call ran; null when no counted call has a timestamp. */
  firstDay: string | null;
  lastDay: string | null;
  harnessModels: HarnessModelCount[];
  /** Failed calls by `errorCode`, from calls captured at a version that records it. */
  errorClasses: { [code: string]: number };
  /** Failed calls captured before `errorCode` existed: counted here, never as zero in `errorClasses`. */
  notMeasured: number;
}

export interface PackageBooks {
  rows: PackageRow[];
  /** Pulled names outside the public list: how many names and calls, never the names. */
  notPublic: { names: number; calls: number };
  /** What the A38 exclusion removed before any count. */
  excluded: { transcripts: number; calls: number };
}

interface Tally {
  calls: number;
  failed: number;
  sessions: Set<string>;
  days: Set<string>;
  harnessModels: Map<string, HarnessModelCount>;
  errorClasses: Map<string, number>;
  notMeasured: number;
}

const tally = (): Tally => ({ calls: 0, failed: 0, sessions: new Set(), days: new Set(), harnessModels: new Map(), errorClasses: new Map(), notMeasured: 0 });

const isMeasured = (tool: ToolObservation): boolean => Number(tool.cv) >= ERROR_CODE_SINCE;

/** A pulled name is public when its ecosystem's pinned snapshot or the curated list names it (the rule the field-report script applied). */
const isPublic = (vocab: Vocabulary, key: string): boolean => {
  const colon = key.indexOf(':');
  return projectStoredPackage(vocab, { package: key, packageVersion: null }).package !== 'private' || PUBLIC_PACKAGES.has(key.slice(colon + 1));
};

/**
 * Calls per package from `store.tools`, the reader's own rows (latest capture of each transcript), without the transcripts `excluded` names.
 * A transcript drops when it or its main session is excluded, so a subagent goes with its parent. `cutoff` is an ISO time; a call with no time is kept only without one.
 */
export const packageBooks = (store: Store, excluded: ReadonlySet<string>, vocab: Vocabulary, cutoff?: string): PackageBooks => {
  const harnesses = new Map([...store.sessions, ...store.subagents].map((session) => [session.session, harnessOf(session)]));
  const promptModel = new Map(store.prompts.map((prompt) => [`${prompt.session}#${String(prompt.index)}`, prompt.model]));
  const transcripts = new Set<string>();
  for (const record of [...store.sessions, ...store.subagents]) if (excluded.has(record.session) || excluded.has(record.parent ?? record.session)) transcripts.add(record.session);
  const removed = { transcripts: 0, calls: 0 };
  const public_ = new Map<string, Tally>();
  const otherNames = new Map<string, number>();
  for (const tool of store.tools) {
    if (excluded.has(tool.session) || excluded.has(tool.parent)) {
      transcripts.add(tool.session);
      removed.calls += 1;
      continue;
    }
    if (cutoff !== undefined && (tool.ts === null || tool.ts < cutoff)) continue;
    const keys = new Set<string>();
    for (const pull of tool.pulls ?? []) {
      const resolved = resolvePull(pull);
      if (resolved !== null) keys.add(resolved.package);
    }
    if (keys.size === 0) continue;
    const harness = harnesses.get(tool.session) ?? 'claude-code';
    const named = tool.model ?? (tool.prompt === null ? undefined : promptModel.get(`${tool.session}#${String(tool.prompt)}`)) ?? NO_MODEL;
    const model = named === NO_MODEL || vocab.models.has(named.toLowerCase()) ? named.toLowerCase() : OTHER_MODEL;
    const failed = tool.status === 'error';
    for (const key of keys) {
      if (!isPublic(vocab, key)) {
        otherNames.set(key, (otherNames.get(key) ?? 0) + 1);
        continue;
      }
      const row = public_.get(key) ?? tally();
      public_.set(key, row);
      row.calls += 1;
      row.sessions.add(tool.parent);
      if (tool.ts !== null) row.days.add(tool.ts.slice(0, 10));
      const cell = row.harnessModels.get(`${harness} ${model}`) ?? { harness, model, calls: 0, failed: 0 };
      row.harnessModels.set(`${harness} ${model}`, cell);
      cell.calls += 1;
      if (!failed) continue;
      row.failed += 1;
      cell.failed += 1;
      if (!isMeasured(tool)) row.notMeasured += 1;
      else row.errorClasses.set(tool.errorCode ?? NO_CLASS, (row.errorClasses.get(tool.errorCode ?? NO_CLASS) ?? 0) + 1);
    }
  }
  removed.transcripts = transcripts.size;
  const rows = [...public_.entries()]
    .map(([key, row]): PackageRow => {
      const days = [...row.days].sort();
      return {
        package: key,
        calls: row.calls,
        failed: row.failed,
        sessions: row.sessions.size,
        firstDay: days[0] ?? null,
        lastDay: days[days.length - 1] ?? null,
        harnessModels: [...row.harnessModels.values()].sort((a, b) => a.harness.localeCompare(b.harness) || a.model.localeCompare(b.model)),
        errorClasses: Object.fromEntries([...row.errorClasses.entries()].sort(([a], [b]) => a.localeCompare(b))),
        notMeasured: row.notMeasured,
      };
    })
    .sort((a, b) => a.package.localeCompare(b.package));
  return { rows, notPublic: { names: otherNames.size, calls: [...otherNames.values()].reduce((sum, calls) => sum + calls, 0) }, excluded: removed };
};

const plural = (count: number, one: string): string => `${String(count)} ${one}${count === 1 ? '' : 's'}`;

/** Text for `books --by package`: one block per package in name order (no rank), then the not-public line and the exclusion line. */
export const formatPackageBooks = (result: PackageBooks): string => {
  const blocks = result.rows.map((row) => {
    const classes = Object.entries(row.errorClasses).map(([code, count]) => `${code} ${String(count)}`);
    const errors = [...classes, ...(row.notMeasured === 0 ? [] : [`not measured ${String(row.notMeasured)} (captured before error classes were recorded)`])];
    return [
      `${row.package}: ${plural(row.calls, 'call')}, ${String(row.failed)} failed, ${plural(row.sessions, 'session')}, ${row.firstDay ?? '-'} to ${row.lastDay ?? '-'} (UTC)`,
      ...row.harnessModels.map((cell) => `  ${cell.harness} ${cell.model}: ${plural(cell.calls, 'call')}, ${String(cell.failed)} failed`),
      ...(errors.length === 0 ? [] : [`  failed by class: ${errors.join(', ')}`]),
    ].join('\n');
  });
  const body = result.rows.length === 0 ? ['No public package pulls in the store.'] : blocks;
  return [
    ...body,
    `Not on the public list: ${plural(result.notPublic.names, 'name')}, ${plural(result.notPublic.calls, 'call')}, not named here.`,
    `Exclusions applied: ${plural(result.excluded.transcripts, 'transcript')} and ${plural(result.excluded.calls, 'call')} removed before counting.`,
  ].join('\n');
};
