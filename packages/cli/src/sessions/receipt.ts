// `oars sessions recall --error <text> --receipt`: a fenced Markdown block a person pastes into an issue on the failing tool. It states the tool and
// harness by listed name, the error's normalized signature, how many earlier sessions hit it and in which weeks, and what those sessions did next. It
// reads the same match recall does and the same redactor, so nothing here is a second path to a stored string.
import { ACTION_TABLES } from './actions.js';
import { redactTranscript } from './redact.js';
import { recall, type RecallQuery } from './query.js';
import { LITERAL } from './public-vocabulary.js';
import { closedName } from './recall-render.js';
import { harnessOf } from './schema.js';
import type { Store } from './store.js';

export const RECEIPT_FOOTER = 'from my local oars record, manyoars.com';
export const RECEIPT_MISS = 'No earlier session in the local record hit this error, so there is no receipt.';
const OTHER = 'other';
const SIGNATURE_LIMIT = 120;
const NEXT_SHOWN = 3;
const MCP_WORD = /mcp__[A-Za-z0-9_-]+/g;
const DAY_MS = 86_400_000;

/** A tool as a person may name it in an issue: a listed name as it stands, anything else `other`. */
const listedTool = (name: string): string => {
  const listed = closedName(name);
  return listed === LITERAL ? OTHER : listed;
};

const listedHarness = (name: string): string => (Object.hasOwn(ACTION_TABLES, name) ? name : OTHER);

/** ISO 8601 week of a timestamp, as `2026-W45`; the week holds the Thursday, which fixes the year. */
export const isoWeek = (ts: string): string | undefined => {
  const at = Date.parse(ts);
  if (Number.isNaN(at)) return undefined;
  const day = new Date(Math.floor(at / DAY_MS) * DAY_MS);
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  const thursday = new Date(day.getTime() + (4 - weekday) * DAY_MS);
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / DAY_MS / 7) + 1;
  return `${String(thursday.getUTCFullYear())}-W${String(week).padStart(2, '0')}`;
};

const times = (count: number): string => `${String(count)} ${count === 1 ? 'time' : 'times'}`;

/** The receipt for the best-matching signature of an error text, or null when no earlier session hit it. */
export const receiptOf = (store: Store, query: RecallQuery, now: number, redactDomains: readonly string[] = [], names: readonly string[] = []): string | null => {
  const [top] = recall(store, query, now, 1, redactDomains).matches;
  if (top === undefined) return null;
  const rows = store.errors.filter((error) => error.sig === top.sig);
  const sessionIds = new Set(rows.map((error) => error.session));
  const harnesses = [...new Set(store.sessions.filter((session) => sessionIds.has(session.session)).map((session) => listedHarness(harnessOf(session))))].sort();
  const weeks = [...new Set(rows.flatMap((error) => { const week = error.ts === null ? undefined : isoWeek(error.ts); return week === undefined ? [] : [week]; }))].sort().reverse();
  // Listed tool names folded together: two unlisted tools are both `other`, once.
  const next = new Map<string, number>();
  for (const { tool, count } of top.followedBy) next.set(listedTool(tool), (next.get(listedTool(tool)) ?? 0) + count);
  const followed = [...next.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, NEXT_SHOWN).map(([tool, count]) => `${tool} x${String(count)}`);
  // The key is `<tool> | <text>`; the tool is stated by its listed name. The text first loses the literals the store records for the matched sessions
  // (branches, project slugs; the transcript rules have no rule for either), then runs through the transcript rules (home paths, encoded folder slugs,
  // local names, secrets), and only the redacted result is cut. Every unlisted `mcp__` word becomes `other`, with backticks out so the fence holds.
  const recorded = store.sessions.filter((entry) => sessionIds.has(entry.session));
  const labels = new Map<string, string>();
  for (const entry of recorded) {
    for (const branch of entry.branches) labels.set(branch, '<branch>');
    labels.set(entry.project, '<project>');
  }
  // A literal goes only where it stands as a whole token, so a branch named `main` leaves `domain` and `./main.js` alone.
  const literals = [...labels.entries()].filter(([literal]) => literal.length > 0).sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));
  const scrubbed = literals.reduce((text, [literal, label]) => text.replace(new RegExp(`(?<![A-Za-z0-9_-])${literal.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'g'), label), top.sig.slice(top.sig.indexOf(' | ') + 3));
  const text = redactTranscript(scrubbed, redactDomains, names).text.slice(0, SIGNATURE_LIMIT).replace(MCP_WORD, (word) => listedTool(word)).replaceAll('`', "'");
  return [
    '```markdown',
    '**Error receipt**',
    '',
    `- Tool: ${listedTool(top.tool)}`,
    `- Harness: ${harnesses.join(', ') || OTHER}`,
    `- Error: \`${text}\``,
    `- Earlier sessions that hit it: ${String(top.sessions)} (${times(top.count)})`,
    `- Weeks: ${weeks.join(', ') || 'unknown'}`,
    `- What they did next: ${followed.join(', ') || 'nothing recorded'}; an edit followed ${times(top.editFollowed)}`,
    '',
    RECEIPT_FOOTER,
    '```',
  ].join('\n');
};
