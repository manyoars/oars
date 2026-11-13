// The data card of a skeleton-only release: README.md, written into the build's folder from the build's own pack.json and census.json, so every number on it is the build's.
// It states no price and no lot 1 count; /packs holds prices and rights.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LOTS_PAGE = 'https://manyoars.com/packs';
// The license is the owner's to choose before an upload; until then the card states the rights page, as the lots page does. One constant, so a ruling changes one line.
export const CARD_LICENSE = { id: 'other', link: `${LOTS_PAGE}#rights` } as const;
export const CARD_TAG = 'agent-traces';

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

/** The card's text from the two files' parsed contents. */
export const cardOf = (pack: unknown, census: unknown): string => {
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
    `${String(sessions)} coding-agent session skeletons from Many Oars Co., each a record of the session's steps, errors, recoveries, and human interventions. No transcript text is in this release, and every session ended at least ${String(days)} days before it was built${typeof built === 'string' ? ` (${built.slice(0, 10)})` : ''}.`,
    '',
    `- License and rights: ${CARD_LICENSE.link}.`,
    `- Redaction version: ${typeof redaction === 'string' ? redaction : 'unknown'}; model reasoning: ${typeof reasoning === 'string' ? reasoning : 'unknown'}. Redaction is best effort.`,
    '- Layout: `manifest.jsonl` (one row per session, `transcripts: 0`), `sessions/<match id>/skeleton.json`, `census.json` (counts only), and `pack.json` (how it was built).',
    '- Check it: `npm run validate-pack -w packages/pool -- <this folder>` in the Many Oars repository (spec: `docs/session-record.md`). It needs no key, account, or network.',
    `- Fresher sessions, whole transcripts, and rights for use: ${LOTS_PAGE}.`,
    '',
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

/** Reads `pack.json` and `census.json` in the folder and writes `README.md` beside them. */
export const writeCard = async (folder: string): Promise<void> => {
  const [pack, census] = await Promise.all(['pack.json', 'census.json'].map(async (name): Promise<unknown> => JSON.parse(await readFile(join(folder, name), 'utf8'))));
  await writeFile(join(folder, 'README.md'), cardOf(pack, census));
};
