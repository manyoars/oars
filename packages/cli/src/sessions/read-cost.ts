// Cost (rank 3): tokens and wall time per prompt, by prompt class, model, and ISO week. Confounders: class drift, subagent work outside the prompt's own usage, and
// task size, which nothing here can see. Tokens are plain counts, not priced. A prompt with no wall time adds no seconds and stays in the denominator, so seconds per prompt understates.
import { bucketFields, isPromptClass, UNKNOWN, type Cell } from './cells.js';
import { motifName } from './motif.js';
import { body, atGrain, groupBy, rate, settled, total, type DeriveFamily } from './read-support.js';

const DAY_MS = 86_400_000;

/** The ISO 8601 week of a UTC day: the week belongs to the year of its Thursday. */
export const isoWeek = (day: string): string => {
  const millis = Date.parse(day);
  const weekday = (new Date(millis).getUTCDay() + 6) % 7;
  const thursday = new Date(millis - weekday * DAY_MS + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${String(year)}-W${String(week).padStart(2, '0')}`;
};

const weekOf = (cell: Cell): string => (cell.day === UNKNOWN ? UNKNOWN : isoWeek(cell.day));

const promptsWithTokens = (cells: readonly Cell[]): number | undefined => {
  let sum = 0;
  for (const cell of cells) {
    if (cell.tokenPrompts === undefined) return undefined;
    sum += cell.tokenPrompts;
  }
  return sum;
};

export const deriveCost: DeriveFamily = ({ pool }) => {
  const classed = atGrain(pool, 'week').flatMap((cell) => {
    const motif = pool.motifs.get(cell.motifId);
    return motif?.level === 'class' && isPromptClass(motif.cls) ? [{ cell, motif, model: bucketFields(cell.frameBucket).model }] : [];
  });
  return [...groupBy(classed, ({ cell, model }) => `${cell.motifId}/${model}/${weekOf(cell)}`).values()].flatMap((group) => {
    const [first] = group;
    if (first === undefined) return [];
    const cells = group.map(({ cell }) => cell);
    const prompts = total(cells, settled);
    // Tokens hold only the prompts that recorded input, so they are divided by those prompts. A cell read back from a pool row written before coverage was stored says no count, and the group's coverage is then unknown: no figure, never a guess at full coverage.
    const covered = promptsWithTokens(cells);
    return [
      body('cost', cells, {
        slice: { class: motifName(first.motif), model: first.model, week: weekOf(first.cell) },
        value: { tokensPerPrompt: covered === undefined || covered === 0 ? null : Math.round(total(cells, (cell) => cell.tokens ?? 0) / covered), ...(covered === undefined ? { tokenCoverage: 'unknown' } : {}), secondsPerPrompt: Math.round(total(cells, (cell) => cell.durationMs) / prompts / 1000), errorShare: rate(total(cells, (cell) => cell.failed), prompts) },
        n: prompts,
        interval: null,
      }),
    ];
  });
};
