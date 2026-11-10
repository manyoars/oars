// The weekly line: once per ISO week, on the first command a person runs on or after Friday 00:00 local time, stderr gets one line pointing at `oars card --text`.
// A stable tenth of installs never see it (the holdback), so the loop's effect can be read later. It is for people at a terminal only: never `--json`, a hook, the MCP
// server, or `oars card` itself. It makes no network call and never fails or delays a command: every error is swallowed.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isHook } from '../telemetry/observe.js';
import type { CardLineArm } from '../telemetry/schema.js';
import { cardOf } from './card.js';
import { mkdirOwnerOnly, writeOwnerOnly } from './owner-only.js';
import { loadStore } from './store.js';
import { readSurvival } from './survival.js';

/** Out of 100 installs, this many never see the line. */
export const HELD_PERCENT = 10;
const MARKER = 'card-line.json';
const ID_FILE = 'card-line-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FRIDAY = 5;

/** The ISO week (`2026-W45`) of a local date. The week's Thursday names its year. */
export const isoWeekOf = (now: number): string => {
  const date = new Date(now);
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 4 - (date.getDay() || 7), 12);
  const first = new Date(thursday.getFullYear(), 0, 1, 12);
  const week = Math.ceil((Math.round((thursday.getTime() - first.getTime()) / 86_400_000) + 1) / 7);
  return `${String(thursday.getFullYear())}-W${String(week).padStart(2, '0')}`;
};

/** Friday, Saturday, or Sunday local time: the ISO week's last three days, so a first command on or after Friday 00:00 is in the week it counts. */
export const fridayOrLater = (now: number): boolean => {
  const day = new Date(now).getDay();
  return day === 0 || day >= FRIDAY;
};

/** The week's text. Singular at one; nothing else (no install, star, or link words). */
export const cardLineText = (sessions: number, strokes: number): string =>
  `Your week: ${String(sessions)} ${sessions === 1 ? 'session' : 'sessions'}, ${String(strokes)} ${strokes === 1 ? 'stroke' : 'strokes'}. \`oars card --text\` for the table.\n`;

const readTrimmed = async (file: string): Promise<string | undefined> => {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    return undefined;
  }
};

/**
 * This install's id for the holdback, frozen at the first decision so the arm never flips: the id file in the store folder when it exists; otherwise it is seeded from
 * the telemetry install id when that file exists (never created here, so a person who turned telemetry off gets no new file), else a random value, and written.
 */
const holdbackId = async (storeDir: string, telemetryDir: string | undefined): Promise<string> => {
  const own = await readTrimmed(join(storeDir, ID_FILE));
  if (own !== undefined && UUID.test(own)) return own;
  const shared = telemetryDir === undefined ? undefined : await readTrimmed(join(telemetryDir, 'install-id'));
  const id = shared !== undefined && UUID.test(shared) ? shared : randomUUID();
  await mkdirOwnerOnly(storeDir);
  await writeOwnerOnly(join(storeDir, ID_FILE), `${id}\n`);
  return id;
};

/** Stable per install: the first four bytes of a SHA-256 of the id, taken mod 100, under the holdback percent. */
export const isHeld = (id: string): boolean => createHash('sha256').update(`card-line:${id}`).digest().readUInt32BE(0) % 100 < HELD_PERCENT;

export interface CardLineInput {
  storeDir: string;
  telemetryDir?: string | undefined;
  now: number;
  /** Whether stderr is a terminal: the line is for a person reading it. */
  tty: boolean;
  argv: readonly string[];
  /** The command path and flag names the run observed. */
  path: readonly string[];
  flags: readonly string[];
  stderr: (text: string) => void;
}

/** A hook, the MCP server, a recall, `--json`, or `oars card` itself: the line never goes there. */
export const quiet = (input: Pick<CardLineInput, 'argv' | 'path' | 'flags'>): boolean => {
  const { argv, path, flags } = input;
  return path.length === 0 || path[0] === 'card' || path.includes('hook') || (path[0] === 'sessions' && path[1] === 'recall') || isHook([...argv], { path: [...path], flags: [...flags] }) || flags.includes('json') || flags.includes('mcp') || argv.includes('--json');
};

const markedWeek = async (storeDir: string): Promise<string | undefined> => {
  const text = await readTrimmed(join(storeDir, MARKER));
  if (text === undefined) return undefined;
  const parsed: unknown = JSON.parse(text);
  const week: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'week') : undefined;
  return typeof week === 'string' ? week : undefined;
};

const mark = async (storeDir: string, week: string, arm: CardLineArm): Promise<void> => {
  await mkdirOwnerOnly(storeDir);
  await writeOwnerOnly(join(storeDir, MARKER), `${JSON.stringify({ week, arm })}\n`);
};

/**
 * Decides and, when due, prints. A store that cannot be read writes the week's marker as `not_due`, so a failing store costs one command a week; a week with no
 * session leaves the marker unwritten, so it is checked again on each due command and the line can still come later in the week. Returns the arm for the command event; any error reads `not_due`.
 */
export const cardLine = async (input: CardLineInput): Promise<CardLineArm> => {
  try {
    if (!input.tty || quiet(input) || !fridayOrLater(input.now)) return 'not_due';
    const week = isoWeekOf(input.now);
    if ((await markedWeek(input.storeDir).catch(() => undefined)) === week) return 'not_due';
    let card: ReturnType<typeof cardOf>;
    try {
      card = cardOf(await loadStore(input.storeDir), await readSurvival(input.storeDir), 'week', input.now);
    } catch {
      await mark(input.storeDir, week, 'not_due');
      return 'not_due';
    }
    if (card.sessions === 0) return 'not_due';
    const held = isHeld(await holdbackId(input.storeDir, input.telemetryDir));
    const arm: CardLineArm = held ? 'held' : 'shown';
    await mark(input.storeDir, week, arm);
    if (!held) input.stderr(cardLineText(card.sessions, card.strokes));
    return arm;
  } catch {
    return 'not_due';
  }
};
