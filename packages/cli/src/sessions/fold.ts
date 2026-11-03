import { SHELL } from './extract.js';
import type { SessionObservation, ToolObservation } from './schema.js';

// One tool call is one observation (t762). Capture version 8 writes a call once; a record set captured before it holds a second `tool` record, status
// `none`, for every call a resumed transcript replayed. The reader folds those so every count over `store.tools` agrees with the new capture until each
// transcript is captured again.

/**
 * One record per `toolUseId`, in the order of the first record of each. The kept record is the first, with the `status` and `durationMs` of the first
 * record that has a status when its own is `none`, so a call keeps its position, prompt, and target and the result it was given. A record with no id is
 * its own call. Returns the records dropped too, so the session's own counts can be brought into line.
 */
export const foldToolRows = (tools: readonly ToolObservation[]): { tools: ToolObservation[]; dropped: ToolObservation[] } => {
  const first = new Map<string, number>();
  const kept: ToolObservation[] = [];
  const dropped: ToolObservation[] = [];
  for (const tool of tools) {
    const at = tool.toolUseId === null ? undefined : first.get(tool.toolUseId);
    if (tool.toolUseId !== null && at === undefined) first.set(tool.toolUseId, kept.length);
    if (at === undefined) {
      kept.push(tool);
      continue;
    }
    dropped.push(tool);
    const held = kept[at];
    if (held !== undefined && held.status === 'none' && tool.status !== 'none') kept[at] = { ...held, status: tool.status, durationMs: tool.durationMs };
  }
  return { tools: kept, dropped };
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
