// `oars card`: reads the local store, prints the card as a table (`--text`) or saves it as an SVG and a PNG, and prints one prefilled x.com link. Nothing is
// uploaded and no network call is made.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Outcome } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { cardOf, cardText, tweetLink, type CardPeriod } from './card.js';
import { cardPng, cardSvg } from './card-render.js';
import { emptyBooks } from './empty-state.js';
import { poolServer } from './pool-command.js';
import { outboxFolder } from './pool-outbox.js';
import { loadSignIns } from './pool-replica.js';
import { sentLog } from './pool-sent.js';
import { loadStore } from './store.js';
import { readSurvival } from './survival.js';
import type { SessionsDeps } from './command.js';

export const ASHORE = 'ashore: run oars pool login';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** 1970-01-01 was a Thursday, so this is the Monday before it: weeks counted from here start on a Monday, UTC. */
const FIRST_MONDAY = -3 * DAY;

/**
 * The depositor row. Signed out it points at `oars pool login`; signed in it counts the weeks (Monday-start, UTC) in which this machine's sent record holds a deposit,
 * labeled as this machine's because the record is local. It reads two local files and makes no network call; a sign-in file or pool address that cannot be read is
 * signed out, since a share card must not fail on it.
 */
export const depositorLine = async (storeDir: string, env: NodeJS.ProcessEnv, now: number): Promise<string> => {
  try {
    const server = poolServer(env, 'card');
    const signedIn = (await loadSignIns(storeDir, 'card')).some((entry) => entry.server === server && entry.expiresAt > now);
    if (!signedIn) return ASHORE;
    const weeks = new Set<number>();
    for (const at of (await sentLog(outboxFolder(storeDir, server))).values()) {
      const time = Date.parse(at);
      if (!Number.isNaN(time)) weeks.add(Math.floor((time - FIRST_MONDAY) / WEEK));
    }
    return `weeks rowing (this machine): ${String(weeks.size)}`;
  } catch (error) {
    if (error instanceof CliError) return ASHORE;
    throw error;
  }
};

export interface CardOptions {
  period: CardPeriod;
  text: boolean;
  /** A `.png` or `.svg` path: both pictures are written, with this name's extension swapped for each. */
  out?: string | undefined;
  /** Leave the cost row out of the picture, the table, and the JSON. */
  noCost?: boolean | undefined;
}

/** The two paths a card is saved to: `--out` names the base, the default is one per period in the working directory. */
export const cardPaths = (period: CardPeriod, out: string | undefined): { svg: string; png: string } => {
  if (out !== undefined && !/\.(?:png|svg)$/i.test(out)) throw new CliError(`--out ${out} must end in .png or .svg.`, ExitCode.USAGE, 'usage');
  const base = resolve(out === undefined ? `oars-card-${period}` : out.replace(/\.(?:png|svg)$/i, ''));
  return { svg: `${base}.svg`, png: `${base}.png` };
};

export const sessionsCard = async (deps: SessionsDeps, options: CardOptions, env: NodeJS.ProcessEnv): Promise<Outcome> => {
  if (deps.sessions === undefined) throw new CliError('The session store is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  const paths = cardPaths(options.period, options.out);
  const store = await loadStore(deps.sessions.storeDir);
  const card = cardOf(store, await readSurvival(deps.sessions.storeDir), options.period, deps.now(), options.noCost !== true);
  const link = tweetLink(card);
  if (card.sessions === 0) {
    const empty = store.sessions.length === 0 && store.prompts.length === 0 ? emptyBooks('prompts') : `No sessions in the last ${String(card.days)} days in the local store.`;
    return { document: { ok: true, card, saved: null, tweet: null }, text: empty };
  }
  const depositor = await depositorLine(deps.sessions.storeDir, env, deps.now());
  if (options.text) return { document: { ok: true, card, saved: null, tweet: link }, text: [cardText(card, depositor), '', link].join('\n') };
  const svg = cardSvg(card, depositor);
  await mkdir(dirname(paths.svg), { recursive: true });
  await writeFile(paths.svg, svg);
  await writeFile(paths.png, cardPng(svg));
  return { document: { ok: true, card, saved: paths, tweet: link }, text: [`Saved ${paths.png}`, `Saved ${paths.svg}`, 'Nothing was uploaded: the card was made from your local store.', '', `Post it (add the picture yourself): ${link}`].join('\n') };
};
