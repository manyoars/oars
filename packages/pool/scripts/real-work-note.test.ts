// The real-work release note: fixture stores with two harness version buckets, built in a temp folder from invented transcripts. No test reads a real store.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_INPUT_KEYS } from '../../cli/src/sessions/public-vocabulary.js';
import { PROMPT_CLASSES } from '../../cli/src/sessions/schema.js';
import { bash, edit, fixture, idOf, read, removeFixtures, TERM, type Call, type Fixture, type Spec } from './real-work-fixture.js';
import { apart, meanInterval, main, MAX_MOVES, NOTE_SPEC, noteOf, wilson, type Note } from './real-work-note.js';
import { HARNESS_NAMES, tableOf } from './real-work-table.js';

afterEach(removeFixtures);

const OLD = '2.1.300';
const NEW = '2.1.320';
const OLD_BUCKET = '2.1.30x';
const NEW_BUCKET = '2.1.32x';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';
const DATE = '2026-11-13';
const NOTE_FILE = `note-${DATE}-claude-code-${OLD_BUCKET}-to-${NEW_BUCKET}.json`;

let counter = 0;
const session = (version: string, model: string, calls: Call[], extra: { project?: string; text?: string } = {}): Spec => {
  counter += 1;
  return { id: idOf(counter), project: extra.project ?? '-work-oars', version, model, prompts: [{ text: extra.text ?? 'fix the parser', calls }] };
};
/** Ten Bash calls, the first `failures` of them failed and nothing after them an edit, so no failure is recovered. */
const tens = (failures: number): Call[] => Array.from({ length: 10 }, (_, at) => bash(at >= failures));
/** `perSession[i]` failures in the i-th session's ten calls, on the version. */
const sessions = (version: string, model: string, perSession: readonly number[]): Spec[] => perSession.map((failures) => session(version, model, tens(failures)));

const stock = async (specs: readonly Spec[]): Promise<Fixture> => {
  const f = fixture();
  for (const spec of specs) f.add(spec);
  await f.stored();
  return f;
};

/** Opus goes from no failures to half its calls failing between the buckets; sonnet stays at one in ten. */
const planted = (): Spec[] => [
  ...sessions(OLD, OPUS, [0, 0, 0, 0, 0, 0]),
  ...sessions(NEW, OPUS, [5, 5, 5, 5, 5, 5]),
  ...sessions(OLD, SONNET, [1, 1, 1, 1, 1, 1]),
  ...sessions(NEW, SONNET, [1, 1, 1, 1, 1, 1]),
];
/** One failure in ten calls on the older bucket, one or two on the newer: a difference of one call in sixty. */
const quiet = (): Spec[] => [...sessions(OLD, OPUS, [1, 1, 1, 1, 1, 1]), ...sessions(NEW, OPUS, [1, 1, 1, 1, 1, 2])];

const options = (f: Fixture, extra: { minSessions?: number; from?: string; to?: string } = {}) => ({
  terms: f.terms,
  owners: f.owners,
  minSessions: extra.minSessions ?? 5,
  date: DATE,
  harness: 'claude-code',
  from: extra.from ?? OLD_BUCKET,
  to: extra.to ?? NEW_BUCKET,
});
const build = async (f: Fixture, extra: { minSessions?: number } = {}): Promise<Note> => noteOf(f.runtime, options(f, extra));
const text = (note: Note): string => `${JSON.stringify(note, null, 2)}\n`;

const flags = (f: Fixture, extra: readonly string[] = []): string[] => ['--terms', f.terms, '--owners', f.owners, '--out', f.out, '--harness', 'claude-code', '--from', OLD_BUCKET, '--to', NEW_BUCKET, ...extra];
const io = (f: Fixture, printed: string[]) => ({ runtime: f.runtime, print: (line: string) => printed.push(line), now: () => Date.parse('2026-11-13T12:00:00Z') });

describe('guards of the release note', () => {
  it('runs the exclusion terms and the owner filter before any count', async () => {
    const plain = await stock(planted());
    const before = await build(plain);
    const f = await stock([
      ...planted(),
      // A session that holds a listed term and one in a folder no owner names, each with enough failed calls to move a count and a bucket's n.
      session(NEW, OPUS, Array.from({ length: 10 }, () => bash(false)), { text: `fix the ${TERM} parser` }),
      session(NEW, OPUS, Array.from({ length: 10 }, () => bash(false)), { project: '-work-elsewhere' }),
    ]);
    const note = await build(f);
    expect(note).toEqual(before);
    expect(text(note)).toBe(text(before));
    expect(note.to.sessions).toBe(12);
  });

  it('holds no name outside the closed vocabulary', async () => {
    const f = await stock([
      ...planted(),
      ...sessions(OLD, 'my-private-finetune-v2', [0, 0, 0, 0, 0, 0]),
      ...sessions(NEW, 'my-private-finetune-v2', [5, 5, 5, 5, 5, 5]),
      ...Array.from({ length: 6 }, () => session(NEW, SONNET, [{ tool: 'mcp__acme_secret__lookup', input: { q: 1 }, ok: false }, read()])),
    ]);
    const note = await build(f);
    const allowed = new Set<string>([
      ...HARNESS_NAMES, ...PROMPT_CLASSES, ...TOOL_INPUT_KEYS.keys(), 'other', 'unknown', OLD_BUCKET, NEW_BUCKET, OPUS, SONNET, 'one fleet', NOTE_SPEC, DATE, 'moves', 'no change',
      'failureRate', 'callsToRecover', 'editFollowedShare', 'interventionsPerPrompt', 'tokensPerPrompt', 'calls', 'failures', 'recoveries', 'prompts', 'model', 'tool',
    ]);
    const keys = new Set(['spec', 'label', 'builtOn', 'harness', 'from', 'to', 'versionBucket', 'sessions', 'calls', 'minSessions', 'result', 'moves', 'measure', 'kind', 'name', 'class', 'unit', 'value', 'n']);
    const strings: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') strings.push(`${path}=${value}`);
      else if (Array.isArray(value)) value.forEach((item, at) => {
        walk(item, `${path}[${String(at)}]`);
      });
      else if (typeof value === 'object' && value !== null) {
        for (const [key, item] of Object.entries(value)) {
          expect(keys.has(key), `key ${key}`).toBe(true);
          walk(item, `${path}.${key}`);
        }
      }
    };
    walk(note, '');
    expect(strings.length).toBeGreaterThan(0);
    for (const entry of strings) expect(allowed.has(entry.slice(entry.indexOf('=') + 1)), entry).toBe(true);
    const written = text(note);
    expect(written).not.toContain('my-private-finetune');
    expect(written).not.toContain('acme_secret');
    // The private model and the private tool are `other`, which no move names; the public tool they share a bucket with still moves.
    expect(note.moves.some((move) => move.name === 'other' || move.name === 'unknown')).toBe(false);
    expect(note.moves.some((move) => move.name === OPUS)).toBe(true);
  });

  it('refuses to write inside a repository, and writes nothing', async () => {
    const f = await stock(planted());
    const printed: string[] = [];
    const inside = join(f.root, 'work', 'app', 'out');
    expect(await main(['--terms', f.terms, '--owners', f.owners, '--out', inside, '--harness', 'claude-code', '--from', OLD_BUCKET, '--to', NEW_BUCKET], io(f, printed))).toBe(2);
    expect(printed.join('\n')).toContain('inside a git repository');
    expect(existsSync(inside)).toBe(false);
    expect(existsSync(join(inside, NOTE_FILE))).toBe(false);
  });

  it('ends with a plain error and no file when a bucket is missing', async () => {
    const f = await stock(sessions(OLD, OPUS, [0, 0, 0, 0, 0, 0]));
    const printed: string[] = [];
    expect(await main(flags(f), io(f, printed))).toBe(2);
    expect(printed.join('\n')).toBe(`The ${NEW_BUCKET} bucket of claude-code has 0 sessions after the gates, under the minimum of 5. No note was written.`);
    expect(existsSync(f.out)).toBe(false);
    await expect(build(f)).rejects.toThrow(`${NEW_BUCKET} bucket`);
  });

  it('ends with a plain error and no file when a bucket is under the minimum n', async () => {
    const f = await stock([...sessions(OLD, OPUS, [0, 0, 0, 0, 0, 0]), ...sessions(NEW, OPUS, [5, 5, 5])]);
    const printed: string[] = [];
    expect(await main(flags(f), io(f, printed))).toBe(2);
    expect(printed.join('\n')).toBe(`The ${NEW_BUCKET} bucket of claude-code has 3 sessions after the gates, under the minimum of 5. No note was written.`);
    expect(existsSync(f.out)).toBe(false);
    // The minimum is the table's own option: at 3 the same store writes a note.
    expect(await main(flags(f, ['--min-sessions', '3']), io(f, printed))).toBe(0);
    expect(existsSync(join(f.out, NOTE_FILE))).toBe(true);
  });
});

describe('release note', () => {
  it('names a planted regression first, byte for byte against the golden note', async () => {
    const f = await stock(planted());
    const note = await build(f);
    expect(text(note)).toBe(readFileSync(join(import.meta.dirname, 'fixtures', 'real-work-note.expected.json'), 'utf8'));
    expect(note.result).toBe('moves');
    expect(note.moves[0]).toMatchObject({ measure: 'failureRate', kind: 'model', name: OPUS, from: { value: 0, n: 60 }, to: { value: 0.5, n: 60 } });
    expect(await build(f).then(text)).toBe(text(note));
  });

  it('compares rows the table builds, with no second derive path', async () => {
    const f = await stock(planted());
    const note = await build(f);
    const table = await tableOf(f.runtime, { terms: f.terms, owners: f.owners, minSessions: 5, date: DATE });
    const cell = (bucket: string) => table.rows.find((row) => row.kind === 'cell' && row.model === OPUS && row.harness === 'claude-code' && row.versionBucket === bucket);
    const [from, to] = [cell(OLD_BUCKET), cell(NEW_BUCKET)];
    const move = note.moves.find((one) => one.kind === 'model' && one.name === OPUS);
    expect(from?.kind === 'cell' && to?.kind === 'cell').toBe(true);
    expect(move?.from).toEqual({ value: from?.kind === 'cell' ? from.failureRate : undefined, n: from?.kind === 'cell' ? from.calls : undefined });
    expect(move?.to).toEqual({ value: to?.kind === 'cell' ? to.failureRate : undefined, n: to?.kind === 'cell' ? to.calls : undefined });
    expect(note.from).toEqual({ versionBucket: OLD_BUCKET, sessions: 12, calls: 120 });
    expect(note.to).toEqual({ versionBucket: NEW_BUCKET, sessions: 12, calls: 120 });
  });

  it('carries the spec, the build date, the label, the harness, the buckets, and the minimum', async () => {
    const note = await build(await stock(planted()));
    expect(note).toMatchObject({ spec: NOTE_SPEC, label: 'one fleet', builtOn: DATE, harness: 'claude-code', minSessions: 5, from: { versionBucket: OLD_BUCKET }, to: { versionBucket: NEW_BUCKET } });
    // Data, not prose, and no verdict: the file holds no sentence, no score, and no word that judges a move.
    expect(text(note)).not.toMatch(/regress|improv|better|worse|score|rank|pass|win|lose/i);
  });

  it('keeps the three largest moves, largest first, and drops the rest', async () => {
    const f = await stock([
      ...sessions(OLD, OPUS, [0, 0, 0, 0, 0, 0]), ...sessions(NEW, OPUS, [5, 5, 5, 5, 5, 5]),
      ...sessions(OLD, HAIKU, [0, 0, 0, 0, 0, 0]), ...sessions(NEW, HAIKU, [3, 3, 3, 3, 3, 3]),
      ...sessions(OLD, SONNET, [0, 0, 0, 0, 0, 0]), ...sessions(NEW, SONNET, [2, 2, 2, 2, 2, 2]),
    ]);
    const note = await build(f);
    expect(MAX_MOVES).toBe(3);
    // Four candidates (the three models and the Bash tool they share); the 12-in-60 move of the third model is the smallest.
    expect(note.moves.map((move) => `${move.kind}:${move.name}`)).toEqual(['tool:Bash', `model:${OPUS}`, `model:${HAIKU}`]);
  });
});

describe('the noise rule', () => {
  it('writes "no change" and no moves when every difference is inside noise, byte for byte twice', async () => {
    const f = await stock(quiet());
    const note = await build(f);
    expect(note.result).toBe('no change');
    expect(note.moves).toEqual([]);
    expect(note.from.sessions).toBe(6);
    expect(text(note)).toBe(readFileSync(join(import.meta.dirname, 'fixtures', 'real-work-note-quiet.expected.json'), 'utf8'));
    expect(await build(f).then(text)).toBe(text(note));
  });

  it('states a rate\'s interval as the 95 percent Wilson interval, and a move needs the two to be apart', () => {
    const none = wilson(0, 60);
    expect(none.low).toBeCloseTo(0, 6);
    expect(none.high).toBeCloseTo(0.0602, 4);
    const half = wilson(30, 60);
    expect(half.low).toBeCloseTo(0.3773, 4);
    expect(half.high).toBeCloseTo(0.6227, 4);
    expect(apart(none, half)).toBe(true);
    expect(apart(half, none)).toBe(true);
    // One call in sixty of a difference: the intervals share ground.
    expect(apart(wilson(6, 60), wilson(7, 60))).toBe(false);
    // Touching is not apart.
    expect(apart({ low: 0, high: 1 }, { low: 1, high: 2 })).toBe(false);
    expect(apart({ low: 0, high: 1 }, { low: 1.0001, high: 2 })).toBe(true);
  });

  it('states a mean\'s interval as its mean and 1.96 standard errors of the mean', () => {
    const same = meanInterval(1, 6, 6);
    expect(same).toEqual({ low: 1, high: 1 });
    // The values 1, 3, 1, 3: mean 2, sample variance 4/3, standard error sqrt(1/3).
    const spread = meanInterval(2, 20, 4);
    expect(spread.low).toBeCloseTo(2 - 1.96 * Math.sqrt(1 / 3), 6);
    expect(spread.high).toBeCloseTo(2 + 1.96 * Math.sqrt(1 / 3), 6);
  });

  // Six sessions each side whose one failed Bash call an edit follows, after no call on the older bucket and after two reads on the newer.
  const recovering = (gap: number, only: number): Spec[] => Array.from({ length: 6 }, (_, at) => session(gap === 0 ? OLD : NEW, OPUS, at < only
    ? [bash(false), ...Array.from({ length: gap }, read), edit()]
    : [bash(true), ...Array.from({ length: gap }, read), edit()]));

  it('moves calls to recover and tokens per prompt on means whose intervals are apart', async () => {
    const f = await stock([...recovering(0, 6), ...recovering(2, 6)]);
    const note = await build(f);
    expect(note.moves.map((move) => move.measure).sort()).toEqual(['callsToRecover', 'callsToRecover', 'tokensPerPrompt']);
    const recover = note.moves.find((move) => move.measure === 'callsToRecover' && move.kind === 'model');
    expect(recover).toMatchObject({ name: OPUS, unit: 'recoveries', from: { value: 1, n: 6 }, to: { value: 3, n: 6 } });
    const tokens = note.moves.find((move) => move.measure === 'tokensPerPrompt');
    expect(tokens).toMatchObject({ kind: 'model', name: OPUS, unit: 'prompts', from: { n: 6 }, to: { n: 6 } });
    expect(PROMPT_CLASSES.some((cls) => cls === tokens?.class)).toBe(true);
    // The rate measures differ by less than their noise (6 of 12 calls against 6 of 24, and 6 of 6 edits followed against 6 of 6).
    expect(note.moves.some((move) => move.measure === 'failureRate' || move.measure === 'editFollowedShare')).toBe(false);
  });

  it('compares a measure only when both rows hold at least the minimum n of it', async () => {
    // Four of the six sessions recover, so calls to recover rests on 4 recoveries each side: under the 5 the rows need.
    const f = await stock([...recovering(0, 4), ...recovering(2, 4)]);
    const note = await build(f);
    expect(note.moves.some((move) => move.measure === 'callsToRecover')).toBe(false);
    expect(note.moves.some((move) => move.measure === 'tokensPerPrompt')).toBe(true);
  });
});

describe('the command', () => {
  it('writes one dated note file, the same bytes as the note', async () => {
    const f = await stock(planted());
    const printed: string[] = [];
    expect(await main(flags(f), io(f, printed))).toBe(0);
    const file = join(f.out, NOTE_FILE);
    expect(readFileSync(file, 'utf8')).toBe(text(await build(f)));
    expect(printed.join('\n')).toBe(`Wrote ${file}: claude-code ${OLD_BUCKET} to ${NEW_BUCKET}, result "moves", moves: 2.`);
    // A second run writes the same bytes.
    expect(await main(flags(f), io(f, printed))).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(text(await build(f)));
  });

  it('writes the note for a store with no change, and says so', async () => {
    const f = await stock(quiet());
    const printed: string[] = [];
    expect(await main(flags(f), io(f, printed))).toBe(0);
    expect(printed.join('\n')).toContain('result "no change", moves: 0.');
    expect(readFileSync(join(f.out, NOTE_FILE), 'utf8')).toBe(text(await build(f)));
  });

  it('does not compare a mean of one value, even at --min-sessions 1', async () => {
    // One session each side whose failure an edit follows after none and after two calls: the means differ, and a mean of one value has no spread to compare.
    const f = await stock([session(OLD, OPUS, [bash(false), edit()]), session(NEW, OPUS, [bash(false), read(), read(), edit()])]);
    const note = await build(f, { minSessions: 1 });
    expect(note.from.sessions).toBe(1);
    expect(note.moves.some((move) => move.measure === 'callsToRecover' || move.measure === 'tokensPerPrompt')).toBe(false);
  });

  it('reads the positional store folder and the --date flag', async () => {
    const f = await stock(planted());
    const printed: string[] = [];
    const elsewhere = { ...io(f, printed), runtime: { ...f.runtime, storeDir: join(f.root, 'elsewhere') } };
    expect(await main([f.runtime.storeDir, '--date', '2026-01-02', ...flags(f)], elsewhere)).toBe(0);
    expect(existsSync(join(f.out, `note-2026-01-02-claude-code-${OLD_BUCKET}-to-${NEW_BUCKET}.json`))).toBe(true);
    // Without --date the build date is the clock's.
    expect(await main(flags(f), io(f, printed))).toBe(0);
    expect(existsSync(join(f.out, NOTE_FILE))).toBe(true);
  });

  it('refuses a harness, a bucket, or an option it cannot name, and writes nothing', async () => {
    const f = await stock(planted());
    const printed: string[] = [];
    const run = async (...args: string[]): Promise<number> => main(args, io(f, printed));
    const base = ['--terms', f.terms, '--owners', f.owners, '--out', f.out];
    expect(await run(...base, '--harness', 'claude-code', '--from', OLD_BUCKET)).toBe(2);
    expect(await run(...base, '--harness', 'my-own-agent', '--from', OLD_BUCKET, '--to', NEW_BUCKET)).toBe(2);
    expect(await run(...base, '--harness', 'claude-code', '--from', '2.1.3', '--to', NEW_BUCKET)).toBe(2);
    expect(await run(...base, '--harness', 'claude-code', '--from', 'unknown', '--to', NEW_BUCKET)).toBe(2);
    expect(await run(...base, '--harness', 'claude-code', '--from', OLD_BUCKET, '--to', OLD_BUCKET)).toBe(2);
    expect(await run(...base, '--harness', 'claude-code', '--from', OLD_BUCKET, '--to', NEW_BUCKET, '--min-sessions', '0')).toBe(2);
    expect(await run(...base, '--harness', 'claude-code', '--from', OLD_BUCKET, '--to', NEW_BUCKET, '--nope', 'x')).toBe(2);
    expect(printed.every((line) => line.includes('Usage: real-work-note'))).toBe(true);
    expect(existsSync(f.out)).toBe(false);
  });
});
