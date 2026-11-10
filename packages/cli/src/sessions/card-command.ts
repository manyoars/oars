// `oars card`: reads the local store, prints the card as a table (`--text`) or saves it as an SVG and a PNG, and prints one prefilled x.com link. Nothing is
// uploaded and no network call is made.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Outcome } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { cardOf, cardText, tweetLink, type CardPeriod } from './card.js';
import { cardPng, cardSvg } from './card-render.js';
import { emptyBooks } from './empty-state.js';
import { loadStore } from './store.js';
import { readSurvival } from './survival.js';
import type { SessionsDeps } from './command.js';

export const ASHORE = 'ashore: run oars pool login';

export interface CardOptions {
  period: CardPeriod;
  text: boolean;
  /** A `.png` or `.svg` path: both pictures are written, with this name's extension swapped for each. */
  out?: string | undefined;
}

/** The two paths a card is saved to: `--out` names the base, the default is one per period in the working directory. */
export const cardPaths = (period: CardPeriod, out: string | undefined): { svg: string; png: string } => {
  if (out !== undefined && !/\.(?:png|svg)$/i.test(out)) throw new CliError(`--out ${out} must end in .png or .svg.`, ExitCode.USAGE, 'usage');
  const base = resolve(out === undefined ? `oars-card-${period}` : out.replace(/\.(?:png|svg)$/i, ''));
  return { svg: `${base}.svg`, png: `${base}.png` };
};

export const sessionsCard = async (deps: SessionsDeps, options: CardOptions): Promise<Outcome> => {
  if (deps.sessions === undefined) throw new CliError('The session store is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  const paths = cardPaths(options.period, options.out);
  const store = await loadStore(deps.sessions.storeDir);
  const card = cardOf(store, await readSurvival(deps.sessions.storeDir), options.period, deps.now());
  const link = tweetLink(card);
  if (card.sessions === 0) {
    const empty = store.sessions.length === 0 && store.prompts.length === 0 ? emptyBooks('prompts') : `No sessions in the last ${String(card.days)} days in the local store.`;
    return { document: { ok: true, card, saved: null, tweet: null }, text: empty };
  }
  if (options.text) return { document: { ok: true, card, saved: null, tweet: link }, text: [cardText(card, ASHORE), '', link].join('\n') };
  const svg = cardSvg(card, ASHORE);
  await mkdir(dirname(paths.svg), { recursive: true });
  await writeFile(paths.svg, svg);
  await writeFile(paths.png, cardPng(svg));
  return { document: { ok: true, card, saved: paths, tweet: link }, text: [`Saved ${paths.png}`, `Saved ${paths.svg}`, 'Nothing was uploaded: the card was made from your local store.', '', `Post it (add the picture yourself): ${link}`].join('\n') };
};
