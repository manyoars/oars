// `oars statusline`: one short line of the person's own local counts, for a terminal status line (Claude Code's `statusLine` first). It reads the local store only: no
// network call, no telemetry event, no write to the store or to any settings file, and nothing in the line can be traced to a path, a repository, a prompt, or a name.
// A status line runs after every assistant message, so a failure here prints the identifier alone and never a stack trace. The counts are `weekOf`'s (the same window
// and rules as `oars card --week --text`), not a second computation.
import { weekOf } from './card-week.js';
import { loadStore } from './store.js';

// wording: owner read pending
export const STATUSLINE_ID = 'oars';

export interface StatuslineOptions {
  storeDir: string;
  now: number;
  /** Bold the identifier with an ANSI escape; off unless the person passes `--color`. */
  color: boolean;
}

const plural = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

/** The one line, without its newline. Never throws. */
export const statuslineLine = async (options: StatuslineOptions): Promise<string> => {
  const id = options.color ? `\u001b[1m${STATUSLINE_ID}\u001b[0m` : STATUSLINE_ID;
  try {
    const week = weekOf(await loadStore(options.storeDir), options.now);
    return `${id} 7d: ${plural(week.sessions, 'session')}, ${plural(week.activeDays, 'active day')}`;
  } catch {
    return id;
  }
};
