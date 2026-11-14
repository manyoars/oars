// The data card of a skeleton-only release: README.md, written into the build's folder from the build's own pack.json and census.json, so every number on it is the build's.
// It states no price and no lot 1 count; /packs holds prices and rights.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { traceOf, type TraceInput } from './skeleton-trace.js';

export const LOTS_PAGE = 'https://manyoars.com/packs';
// The license is the owner's to choose before an upload; until then the card states the rights page, as the lots page does. One constant, so a ruling changes one line.
export const CARD_LICENSE = { id: 'other', link: `${LOTS_PAGE}#rights` } as const;
export const CARD_TAG = 'agent-traces';

/** The fit table: the four rows and answers of `PACKS_FIT` on the marketing site's packs page, word for word. A change there changes this too. */
export const CARD_FIT = [
  ['Building tasks or evals from real sessions', 'Yes. The sessions are raw inputs you turn into tasks.'],
  ["Studying how a coding agent's tool calls fail", 'Yes. You get the structure and sequence of the steps and errors. No label says a later edit fixed anything.'],
  ['Training a model', 'Not offered.'],
  ['A ready-made scored benchmark', 'Not included. A session has no score and no pass or fail label.'],
] as const;

/** The free sample's ask, as the page words it (`PACKS_ASK`): the same address and subject as the page's mailto. */
export const CARD_SAMPLE_ASK = { email: 'support@manyoars.com', subject: 'Session pack sample' } as const;

interface Counted {
  readonly [name: string]: number;
}

const isCounted = (value: unknown): value is Counted => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((count) => typeof count === 'number');
const counted = (value: unknown, what: string): Counted => {
  if (!isCounted(value)) throw new Error(`${what} is not a table of counts.`);
  return value;
};
const count = (value: unknown, what: string): number => {
  if (typeof value !== 'number') throw new Error(`${what} is not a number.`);
  return value;
};
const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined);

const table = (title: string, tally: Counted): string[] => (Object.keys(tally).length === 0 ? [] : ['', `**${title}**`, '', ...Object.entries(tally).map(([name, n]) => `- \`${name}\`: ${String(n)}`)]);

/** The card's text from the two files' parsed contents, and the kept sessions the worked trace reads (none: no trace). */
export const cardOf = (pack: unknown, census: unknown, kept: readonly TraceInput[] = []): string => {
  const [sessions, days, built] = [count(field(census, 'sessions'), 'census sessions'), count(field(pack, 'olderThanDays'), 'pack olderThanDays'), field(pack, 'built')];
  const redaction = field(pack, 'redactionVersion');
  const reasoning = field(pack, 'reasoning');
  const turns = counted(field(census, 'turnBucket'), 'census turnBucket');
  return [
    '---',
    `license: ${CARD_LICENSE.id}`,
    `license_link: ${CARD_LICENSE.link}`,
    'tags:',
    `  - ${CARD_TAG}`,
    '---',
    '',
    '# Many Oars: open session skeletons',
    '',
    `${String(sessions)} coding-agent session skeletons, published by Many Oars Co., each a record of the session's steps, errors, recoveries, and human interventions. No transcript text is in this release, and every session ended at least ${String(days)} days before it was built${typeof built === 'string' ? ` (${built.slice(0, 10)})` : ''}.`,
    '',
    `- License and rights: ${CARD_LICENSE.link}.`,
    `- Redaction version: ${typeof redaction === 'string' ? redaction : 'unknown'}; model reasoning: ${typeof reasoning === 'string' ? reasoning : 'unknown'}. Redaction is best effort.`,
    '- Layout: `manifest.jsonl` (one row per session, `transcripts: 0`), `sessions/<match id>/skeleton.json`, `census.json` (counts only), and `pack.json` (how it was built).',
    '- Check it: `npm run validate-pack -w packages/pool -- <this folder>` in the Many Oars repository (spec: `docs/session-record.md`). It needs no key, account, or network.',
    `- Fresher sessions, whole transcripts, and rights for use: ${LOTS_PAGE}.`,
    '',
    '## Is a pack right for you?',
    '',
    'What a pack is for, and what it is not.',
    '',
    '| Use | Answer |',
    '|---|---|',
    ...CARD_FIT.map(([use, answer]) => `| ${use} | ${answer} |`),
    '',
    '## Try the free sample first',
    '',
    `The free transcript sample comes before any payment. Ask for it at ${LOTS_PAGE}, or write to ${CARD_SAMPLE_ASK.email} with the subject "${CARD_SAMPLE_ASK.subject}". Tell us what you are evaluating. A person answers.`,
    '',
    'A sample of our first lot goes to anyone who asks, with no form and no name.',
    '',
    ...traceOf(kept),
    '## What is counted',
    ...table('Sessions per harness', counted(field(census, 'harness'), 'census harness')),
    ...table('Sessions per harness version', counted(field(census, 'harnessVersion'), 'census harnessVersion')),
    ...table('Prompts per model', counted(field(census, 'model'), 'census model')),
    ...table('Failed calls per error code', counted(field(census, 'errorCode'), 'census errorCode')),
    ...table('Failed calls by what followed', counted(field(census, 'recovery'), 'census recovery')),
    ...table('Prompts per human intervention', counted(field(census, 'intervention'), 'census intervention')),
    ...table('Sessions per turn bucket (lowest turn count of the bucket)', turns),
    '',
  ].join('\n');
};

const isAbsent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** The folder's kept sessions: each manifest row's match id and its `skeleton.json`. A folder with no manifest keeps none. */
const keptOf = async (folder: string): Promise<TraceInput[]> => {
  const text = await readFile(join(folder, 'manifest.jsonl'), 'utf8').catch((error: unknown) => {
    if (isAbsent(error)) return '';
    throw error;
  });
  const ids = text.split(/\r?\n/).filter((row) => row.trim() !== '').map((row): unknown => field(JSON.parse(row), 'matchId')).filter((id): id is string => typeof id === 'string');
  return Promise.all(ids.map(async (matchId): Promise<TraceInput> => ({ matchId, skeleton: JSON.parse(await readFile(join(folder, 'sessions', matchId, 'skeleton.json'), 'utf8')) })));
};

/** Reads `pack.json`, `census.json`, and the kept sessions' skeletons in the folder and writes `README.md` beside them. */
export const writeCard = async (folder: string): Promise<void> => {
  const [pack, census] = await Promise.all(['pack.json', 'census.json'].map(async (name): Promise<unknown> => JSON.parse(await readFile(join(folder, name), 'utf8'))));
  await writeFile(join(folder, 'README.md'), cardOf(pack, census, await keptOf(folder)));
};
