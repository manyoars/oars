// How hook rows sit beside the store reader's records. A hook row is a separately marked observation (`source: 'hook'`): it is never merged into a
// record the reader made from a rollout, never counted as one, and never fills a field the reader left empty. This is the pure rule for which side a
// row stands on; no command reads it yet, so nothing changes in any output until one does.
import type { HookRow } from './codex-hook.js';

/** `beside`: the reader holds this rollout, so its record stands and these rows are shown next to it. `alone`: the reader holds none, so the rows stand by themselves and are degraded. */
export type Standing = 'beside' | 'alone';

export interface HookGroup {
  /** The thread the rows name; null when the payload carried none. */
  session: string | null;
  /** Set for a subagent's rows, which carry the parent's session id. */
  agentId: string | null;
  standing: Standing;
  /** True when the rows stand alone, so the record they make is the degraded one. */
  degraded: boolean;
  /** The rows as written, in order: not copied into a reader record, and not counted as one. */
  rows: readonly HookRow[];
}

/**
 * Groups `rows` by the thread they name (and by subagent, when they name one). A subagent's row carries the parent's session id, so keying it to the
 * parent's rollout would fold one agent's calls into another's record: it always stands alone. `readerSessions` holds the session ids of the rollouts
 * the reader can read; a rollout it refuses is simply absent from it.
 */
export const separateHookRows = (rows: readonly HookRow[], readerSessions: ReadonlySet<string>): HookGroup[] => {
  const groups = new Map<string, { session: string | null; agentId: string | null; rows: HookRow[] }>();
  for (const row of rows) {
    const key = JSON.stringify([row.session, row.agentId]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { session: row.session, agentId: row.agentId, rows: [row] });
    else group.rows.push(row);
  }
  return [...groups.values()].map((group) => {
    const beside = group.agentId === null && group.session !== null && readerSessions.has(group.session);
    return { ...group, standing: beside ? 'beside' : 'alone', degraded: !beside };
  });
};
