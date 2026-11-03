// Layer 4, T0, local (spec 2.4): does the raw file still match the root capture wrote, and do the capture records agree with each other?
// Local only: a local match commits nobody, so no result here raises a tier. It reads `raw/` and `state.json`, and prints ids and counts, never content.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { merkleRootOf, MIN_ROOT_LEAVES, rawLinesOf } from './merkle.js';
import type { SessionObservation, Skeleton } from './schema.js';
import { paths, readState, relativeOfSession, type SessionsRuntime, type State } from './store.js';

/** The T0 result table of spec 2.4, one name per row. */
export const T0_RESULTS = ['root matches and the counts bind', 'changed since deposit', 'root mismatch', 'counts do not bind', 'not run'] as const;
export type T0Result = (typeof T0_RESULTS)[number];

export interface SessionAudit {
  session: string;
  result: T0Result;
  /** `none` means `W` is 0 until a new capture writes a new root; every other T0 result holds the tier at `skeleton`. */
  tier: 'skeleton' | 'none';
  /** How `raw/` holds the file: a hard link to the harness's transcript, or a copy (cross-volume, or a link whose source is gone). Null when there is no raw file or the counts failed first. */
  mode: 'link' | 'copy' | null;
  leaves: number;
  /** Under {@link MIN_ROOT_LEAVES}: the root joins no cluster and the session counts toward no `n` (spec 2.5). */
  belowMinLeaves: boolean;
  changedSinceDeposit: boolean;
  /** A copy whose size differs from `state.json`'s: a copy changes only when `archiveRaw` refreshes it, so growth is not an honest explanation (spec 2.4). */
  possibleTampering: boolean;
  bindings: { leaves: number; sessionLines: number; skeletonLines: number; badLines: number; bind: boolean };
}

const statOrUndefined = (file: string) =>
  stat(file, { bigint: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });

/** The count bindings of spec 2.4: the skeleton's leaves, the session's lines, and the skeleton's lines plus the session's bad lines must all agree. No skeleton is zero leaves and zero lines. */
const bindingsOf = (session: SessionObservation, skeleton: Skeleton | undefined): SessionAudit['bindings'] => {
  const leaves = skeleton?.leaves ?? 0;
  const skeletonLines = skeleton?.lines.length ?? 0;
  return { leaves, sessionLines: session.lines, skeletonLines, badLines: session.badLines, bind: leaves === session.lines && session.lines === skeletonLines + session.badLines };
};

const unrun = (session: string, skeleton: Skeleton | undefined, bindings: SessionAudit['bindings']): SessionAudit => ({
  session,
  result: 'not run',
  tier: 'skeleton',
  mode: null,
  leaves: skeleton?.leaves ?? 0,
  belowMinLeaves: (skeleton?.leaves ?? 0) < MIN_ROOT_LEAVES,
  changedSinceDeposit: false,
  possibleTampering: false,
  bindings,
});

/**
 * One session's T0 result. The count bindings come first and need no raw file: a record set that disagrees with itself is `none` whatever `raw/`
 * holds. `state` is `state.json`, read once by {@link auditStore}.
 */
export const auditSession = async (runtime: SessionsRuntime, session: SessionObservation, skeleton: Skeleton | undefined, state?: State): Promise<SessionAudit> => {
  const bindings = bindingsOf(session, skeleton);
  const base = { session: session.session, leaves: bindings.leaves, belowMinLeaves: bindings.leaves < MIN_ROOT_LEAVES, changedSinceDeposit: false, possibleTampering: false, bindings };
  if (skeleton === undefined) return { ...base, result: 'not run', tier: 'skeleton', mode: null };
  if (!bindings.bind) return { ...base, result: 'counts do not bind', tier: 'none', mode: null };
  const relative = join(session.project, ...relativeOfSession(session.session));
  const rawFile = join(paths(runtime.storeDir).raw, relative);
  const raw = await statOrUndefined(rawFile);
  if (raw === undefined) return { ...base, result: 'not run', tier: 'skeleton', mode: null };
  // The mode is read from the file: with the source's inode it is the link, otherwise a copy (or a link whose source is gone).
  const source = await statOrUndefined(join(runtime.projectsRoot, relative));
  const mode = source !== undefined && source.ino === raw.ino && source.dev === raw.dev ? 'link' : 'copy';
  const held = (state ?? (await readState(runtime.storeDir))).files[relative.split('\\').join('/')];
  // `state.json` holds float milliseconds from a plain `stat`; the match compares against the same reading.
  const plain = await stat(rawFile);
  const sizeHeld = held !== undefined && plain.size === held.size;
  const matches = held !== undefined && sizeHeld && (mode === 'link' ? plain.mtimeMs === held.mtimeMs : plain.mtimeMs >= held.mtimeMs);
  if (!matches) return { ...base, result: 'changed since deposit', tier: 'skeleton', mode, changedSinceDeposit: true, possibleTampering: mode === 'copy' && held !== undefined && !sizeHeld };
  const lines = rawLinesOf(await readFile(rawFile, 'utf8'));
  const recomputed = lines.length < skeleton.leaves ? undefined : merkleRootOf(lines.slice(0, skeleton.leaves));
  return recomputed === skeleton.merkleRoot ? { ...base, result: 'root matches and the counts bind', tier: 'skeleton', mode } : { ...base, result: 'root mismatch', tier: 'none', mode };
};

/**
 * Every session's T0 result, in the order given, then one `not run` for each skeleton with no capture record (a torn or removed observations line), so
 * the table never shrinks without a signal. A session with no skeleton, or whose raw file cannot be read, is also `not run`.
 */
export const auditStore = async (runtime: SessionsRuntime, sessions: readonly SessionObservation[], skeletons: readonly Skeleton[]): Promise<SessionAudit[]> => {
  const state = await readState(runtime.storeDir);
  const bySession = new Map(skeletons.map((skeleton) => [skeleton.session, skeleton]));
  const audits: SessionAudit[] = [];
  for (const session of sessions) {
    const skeleton = bySession.get(session.session);
    // One unreadable raw file (EACCES, EBUSY, too large for a string) costs that session its result, never the others'.
    audits.push(await auditSession(runtime, session, skeleton, state).catch((): SessionAudit => unrun(session.session, skeleton, bindingsOf(session, skeleton))));
  }
  const recorded = new Set(sessions.map((session) => session.session));
  for (const skeleton of skeletons) {
    if (!recorded.has(skeleton.session)) audits.push(unrun(skeleton.session, skeleton, { leaves: skeleton.leaves, sessionLines: 0, skeletonLines: skeleton.lines.length, badLines: 0, bind: false }));
  }
  return audits;
};

export type T0Counts = { [result in T0Result]: number };

export const auditCounts = (audits: readonly SessionAudit[]): T0Counts => {
  const count = (result: T0Result): number => audits.filter((audit) => audit.result === result).length;
  return {
    'root matches and the counts bind': count('root matches and the counts bind'),
    'changed since deposit': count('changed since deposit'),
    'root mismatch': count('root mismatch'),
    'counts do not bind': count('counts do not bind'),
    'not run': count('not run'),
  };
};

/** A count line for every row of the T0 table, then one FAIL line per session at tier `none` and one note per session that changed. */
export const formatAudit = (audits: readonly SessionAudit[]): string => {
  const counts = auditCounts(audits);
  const tampering = audits.filter((audit) => audit.possibleTampering).length;
  const small = audits.filter((audit) => audit.belowMinLeaves).length;
  return [
    `${String(audits.length)} sessions audited against raw (T0, local: a local match commits nobody)`,
    ...T0_RESULTS.map((result) => `      ${result}: ${String(counts[result])}`),
    ...(tampering > 0 ? [`      possible tampering (a copy of a different size): ${String(tampering)}`] : []),
    ...(small > 0 ? [`      under ${String(MIN_ROOT_LEAVES)} leaves, so joined to no cluster and counted toward no n: ${String(small)}`] : []),
    ...audits.filter((audit) => audit.tier === 'none').map((audit) => `FAIL  ${audit.session}: ${audit.result}; weight is 0 until a new capture writes a new root`),
    ...audits.filter((audit) => audit.changedSinceDeposit).map((audit) => `      ${audit.session}: changed since deposit (${audit.mode ?? 'no mode'}${audit.possibleTampering ? ', possible tampering' : ''})`),
  ].join('\n');
};
