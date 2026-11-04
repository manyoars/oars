import { SHELL } from './extract.js';
import type { ErrorLineObservation, SessionObservation, ToolObservation } from './schema.js';

// One tool call is one observation. Capture version 8 writes a call once; a record set captured before it holds a second `tool` record, status
// `none`, for every call a resumed transcript replayed. The reader folds those so every count over `store.tools` agrees with the new capture until each
// transcript is captured again.

/** The record a folded call keeps when a later copy of it is the one with the real line: its status, duration, and the fields a blob copy cannot know. */
const settled = (held: ToolObservation, later: ToolObservation): ToolObservation => {
  const status = held.status === 'none' && later.status !== 'none' ? { status: later.status, durationMs: later.durationMs } : {};
  // A copy with no `ts` came from a line with no `cwd` either, so its path hash is against the working directory, not the repository.
  const line = held.ts === null && later.ts !== null ? { target: later.target, targetBase: later.targetBase, ts: later.ts, harnessVersion: later.harnessVersion } : {};
  return { ...held, ...status, ...line };
};

/**
 * One record per `toolUseId`, in the order of the first record of each. The kept record is the first, with the `status` and `durationMs` of the first
 * record that has a status when its own is `none`, and the `target`, `targetBase`, `ts`, and `harnessVersion` of the first record that has a `ts` when
 * its own has none, so a call keeps its position and prompt and the result and path it was given. A record with no id is its own call.
 *
 * The kept records are renumbered to their place in the array, and each error line's `after` (the count of records written before it) is mapped to the
 * count of kept records written before it, so `derive.ts`, which slices the calls at `after`, reads the calls capture version 8 would have numbered.
 * Returns the records dropped too, so the session's own counts can be brought into line.
 */
export const foldToolRows = (
  written: readonly ToolObservation[],
  errorLines: readonly ErrorLineObservation[],
): { tools: ToolObservation[]; dropped: ToolObservation[]; errorLines: ErrorLineObservation[] } => {
  const first = new Map<string, number>();
  const kept: ToolObservation[] = [];
  const dropped: ToolObservation[] = [];
  const keptAt: number[] = [];
  for (const tool of [...written].sort((a, b) => a.n - b.n)) {
    const at = tool.toolUseId === null ? undefined : first.get(tool.toolUseId);
    if (tool.toolUseId !== null && at === undefined) first.set(tool.toolUseId, kept.length);
    if (at === undefined) {
      kept.push(tool);
      keptAt.push(tool.n);
      continue;
    }
    dropped.push(tool);
    const held = kept[at];
    if (held !== undefined) kept[at] = settled(held, tool);
  }
  // `keptAt` is ascending, so the kept records written before `after` are the ones whose old `n` is below it.
  const before = (after: number): number => {
    let low = 0;
    let high = keptAt.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((keptAt[middle] ?? 0) < after) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return {
    tools: kept.map((tool, n) => ({ ...tool, n })),
    dropped,
    errorLines: errorLines.map((error) => ({ ...error, after: before(error.after) })),
  };
};

/** The session with the dropped calls taken out of its per-tool counts and its shell count, the numbers capture version 8 would have written. */
export const withoutReplays = (session: SessionObservation, dropped: readonly ToolObservation[]): SessionObservation => {
  if (dropped.length === 0) return session;
  const counts = { ...session.tools };
  let shell = session.bashCmds;
  for (const tool of dropped) {
    counts[tool.tool] = Math.max((counts[tool.tool] ?? 0) - 1, 0);
    if (SHELL.has(tool.tool)) shell = Math.max(shell - 1, 0);
  }
  return { ...session, tools: Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0)), bashCmds: shell };
};
