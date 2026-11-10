// `oars card`: the person's own week, month, or year as counts, read from the local store only. It reuses `books` for the prompt-level columns (turns,
// commits, and commit survival) so no second parser of the store exists, and prints nothing a reader of the picture could trace to a folder, a path, a prompt,
// a repository, or a name outside the published model list.
import { firstCopies } from './derive.js';
import { books, BOOKS_MIN_PROMPTS, type BooksShare } from './query.js';
import { publicModel } from './public-vocabulary.js';
import { harnessOf, observesUsage, type PromptObservation, type SessionObservation, type ToolObservation } from './schema.js';
import type { Store } from './store.js';
import type { SurvivalState } from './survival.js';

export type CardPeriod = 'week' | 'month' | 'year';

const DAY_MS = 86_400_000;
const DAYS_IN = { week: 7, month: 30, year: 365 } as const satisfies { [period in CardPeriod]: number };

/** How many models the card names before the rest fold into `other`. */
const MODELS_SHOWN = 3;
export const OTHER = 'other';

export const cardWindow = (period: CardPeriod, now: number): { days: number; end: string } => ({ days: DAYS_IN[period], end: new Date(now).toISOString().slice(0, 10) });

export interface CardModel {
  name: string;
  prompts: number;
  /** Input, cache, and output tokens over the prompts that recorded them. */
  tokens: number;
}

export interface Card {
  period: CardPeriod;
  days: number;
  /** The UTC date the window ends on. */
  windowEnd: string;
  sessions: number;
  activeDays: number;
  harnesses: Array<{ name: string; sessions: number }>;
  models: CardModel[];
  /** Main-line tool calls, each call once. */
  strokes: number;
  /** Tool calls that failed. */
  crabs: number;
  /** Crabs whose next call was a different tool, over the crabs; a share under the floor reads `too few`. */
  movedOn: BooksShare;
  /** Edited prompts that were followed by a command, over edited prompts. */
  verifyAfterEdit: BooksShare;
  commits: number;
  /** Commits whose survival is known, and how many survived. */
  survived: BooksShare;
  /** The harness's own `cost-state` totals, summed over the sessions that have one. Absent under `--no-cost`, so no output form carries it. */
  cost?: { usd: number | null; recorded: number; of: number };
}

const shareOf = (count: number, of: number): BooksShare => ({ count, of, share: of < BOOKS_MIN_PROMPTS ? null : Math.round((count / of) * 1000) / 1000 });

const tokensOf = (prompt: PromptObservation): number => {
  const { input, cacheWrite, cacheRead, output } = prompt.usage;
  // A category the source never recorded is a placeholder zero, so it adds nothing either way; the check keeps the sum to what was measured.
  return input + output + (observesUsage(prompt, 'cacheWrite') ? cacheWrite : 0) + (observesUsage(prompt, 'cacheRead') ? cacheRead : 0);
};

/** Models by prompts, the first few published names kept and every other name, published or not, counted under `other`. */
const modelMix = (prompts: readonly PromptObservation[]): CardModel[] => {
  const byModel = new Map<string, CardModel>();
  for (const prompt of prompts) {
    const entry = byModel.get(prompt.model) ?? { name: prompt.model, prompts: 0, tokens: 0 };
    entry.prompts += 1;
    entry.tokens += tokensOf(prompt);
    byModel.set(prompt.model, entry);
  }
  const ranked = [...byModel.values()].sort((a, b) => b.prompts - a.prompts || a.name.localeCompare(b.name));
  const named = ranked.filter((entry) => publicModel(entry.name) === entry.name).slice(0, MODELS_SHOWN);
  const rest = ranked.filter((entry) => !named.includes(entry));
  return rest.length === 0 ? named : [...named, { name: OTHER, prompts: rest.reduce((total, entry) => total + entry.prompts, 0), tokens: rest.reduce((total, entry) => total + entry.tokens, 0) }];
};

const strokesOf = (tools: readonly ToolObservation[]): number => {
  const bySession = new Map<string, ToolObservation[]>();
  for (const tool of tools) bySession.set(tool.session, [...(bySession.get(tool.session) ?? []), tool]);
  return [...bySession.values()].reduce((total, list) => total + firstCopies(list).length, 0);
};

export const cardOf = (store: Store, survival: ReadonlyMap<string, SurvivalState>, period: CardPeriod, now: number, includeCost = true): Card => {
  const { days, end } = cardWindow(period, now);
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  const prompts = store.prompts.filter((prompt) => prompt.ts !== null && prompt.ts >= cutoff);
  const promptKeys = new Set(prompts.map((prompt) => `${prompt.session}#${String(prompt.index)}`));
  const inWindow = (record: { session: string; prompt: number | null }): boolean => record.prompt !== null && promptKeys.has(`${record.session}#${String(record.prompt)}`);
  const sessionIds = new Set(prompts.map((prompt) => prompt.session));
  const sessions: SessionObservation[] = store.sessions.filter((session) => sessionIds.has(session.session) && session.supersededBy === undefined);
  const crabs = store.errors.filter((error) => error.agent === undefined && inWindow(error));
  // `books` over one group: with no session naming a harness, every prompt falls under the one default key.
  const [row] = books({ ...store, sessions: [], prompts }, 'harness', now, undefined, survival);
  const verified = prompts.filter((prompt) => prompt.cls === 'edit-verify').length;
  const edited = verified + prompts.filter((prompt) => prompt.cls === 'edit-only').length;
  const harnessCounts = new Map<string, number>();
  for (const session of sessions) harnessCounts.set(harnessOf(session), (harnessCounts.get(harnessOf(session)) ?? 0) + 1);
  const costed = sessions.filter((session) => session.costUsd !== null);
  return {
    period,
    days,
    windowEnd: end,
    sessions: sessions.length,
    // The window is a span of hours, so it can touch one more UTC date than it has days; the card caps the count at the window's days.
    activeDays: Math.min(days, new Set(prompts.map((prompt) => (prompt.ts ?? '').slice(0, 10))).size),
    harnesses: [...harnessCounts.entries()].map(([name, count]) => ({ name, sessions: count })).sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name)),
    models: modelMix(prompts),
    strokes: strokesOf(store.tools.filter(inWindow)),
    crabs: crabs.length,
    movedOn: shareOf(crabs.filter((error) => error.next[0] !== undefined && error.next[0] !== error.tool).length, crabs.length),
    verifyAfterEdit: shareOf(verified, edited),
    commits: row?.commits ?? 0,
    survived: row?.survived ?? shareOf(0, 0),
    ...(includeCost ? { cost: { usd: costed.length === 0 ? null : costed.reduce((total, session) => total + (session.costUsd ?? 0), 0), recorded: costed.length, of: sessions.length } } : {}),
  };
};

/** A share as the card prints it: a percent at or over the floor, else `too few`, with the counts it rests on. */
const shareText = (share: BooksShare, unit: string): string =>
  `${share.share === null ? 'too few' : `${String(Math.round(share.share * 100))}%`} (${String(share.count)} of ${String(share.of)} ${unit})`;

const dollars = (usd: number): string => `$${usd.toFixed(2)}`;

export interface CardRow {
  label: string;
  value: string;
}

/** The rows of the card, in order, shared by the table and the picture. `depositor` is the one line the sign-in state decides. */
export const cardRows = (card: Card, depositor: string): CardRow[] => [
  { label: 'sessions', value: `${String(card.sessions)} on ${String(card.activeDays)} active ${card.activeDays === 1 ? 'day' : 'days'}` },
  { label: 'harnesses', value: card.harnesses.map((entry) => `${entry.name} ${String(entry.sessions)}`).join(', ') },
  { label: 'models', value: card.models.map((entry) => `${entry.name} ${String(entry.prompts)}`).join(', ') },
  ...card.models.map((entry) => ({ label: 'tokens', value: `${entry.name} ${String(entry.tokens)}` })),
  { label: 'strokes', value: String(card.strokes) },
  { label: 'crabs', value: String(card.crabs) },
  { label: 'moved on', value: shareText(card.movedOn, 'crabs') },
  { label: 'verified after edit', value: shareText(card.verifyAfterEdit, 'edits') },
  { label: 'commits', value: String(card.commits) },
  { label: 'survived', value: shareText(card.survived, 'settled') },
  ...(card.cost === undefined ? [] : [{ label: 'cost', value: card.cost.usd === null ? 'not recorded by these harnesses' : `${dollars(card.cost.usd)} (${String(card.cost.recorded)} of ${String(card.cost.of)} sessions recorded one)` }]),
  { label: 'depositor', value: depositor },
];

export const CARD_SITE = 'manyoars.com';
export const CARD_COMMAND = 'npx @manyoars/oars card';

export const cardTitle = (card: Card): string => `oars crew card: the last ${String(card.days)} days to ${card.windowEnd}`;

/** The compact table `--text` prints, sized to screenshot in a terminal. */
export const cardText = (card: Card, depositor: string): string => {
  const rows = cardRows(card, depositor).filter((row) => row.value !== '');
  const width = Math.max(...rows.map((row) => row.label.length)) + 2;
  return [cardTitle(card), '', ...rows.map((row) => `${row.label.padEnd(width)}${row.value}`), '', `${CARD_SITE}  ${CARD_COMMAND}`].join('\n');
};

/** The one link `card` prints: X's web intent with the text only. The person adds the picture; nothing is posted from here. */
export const tweetLink = (card: Card): string => {
  const stats = `${String(card.sessions)} ${card.sessions === 1 ? 'session' : 'sessions'}, ${String(card.strokes)} strokes, ${String(card.crabs)} crabs`;
  const text = `My agents, the last ${String(card.days)} days: ${stats}. ${CARD_SITE} ${CARD_COMMAND}`;
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
};
