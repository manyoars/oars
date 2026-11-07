// Every size or count figure in docs/pool.md that the code determines is computed here and compared with the number the doc prints (t913). A merge or a
// new field that moves a size now fails this test, so the doc is fixed before review. The figure sits in the doc as `887,140<!-- figure:skeleton -->`; a
// rounded one names its step, `1,900<!-- figure:sample~100 -->`, and must equal the computed value rounded to that step, so it stays true within its rounding.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, storedNames, store, tool } from '../../cli/src/sessions/pool-fixture.js';
import { canonicalBytes } from '../../cli/src/sessions/pool-outbox.js';
import { envelopeBytes, REGISTER_FIXTURE } from '../../cli/src/sessions/pool-wire-register.test.js';
import { skeletonOf, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import type { CanonicalAction } from '../../cli/src/sessions/actions.js';
import { PUBLIC_PROGRAMS, PUBLIC_SUBCOMMANDS } from '../../cli/src/sessions/public-vocabulary.js';
import { incrementsOf } from './ingest.js';
import { sampleSkeleton } from './sample.js';

const DOC = readFileSync(fileURLToPath(new URL('../../../docs/pool.md', import.meta.url)), 'utf8');

const oneSkeleton = (from: ReturnType<typeof store>, id: string): SessionSkeleton => {
  const [only] = sessionsFrom(from);
  const built = only === undefined ? null : skeletonOf(only, id, storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

/** The 3,400-step deposit of `ingest.test.ts` ("a large deposit"): one prompt of calls on a fixed pseudo-random line, so its cells are mostly distinct. */
const largeSkeleton = (): SessionSkeleton => {
  const natives: [CanonicalAction, string][] = [
    ['file.read', 'Read'],
    ['file.edit', 'Edit'],
    ['file.write', 'Write'],
    ['file.search', 'Grep'],
    ['plan.update', 'TodoWrite'],
    ['shell.exec', 'Bash'],
    ['shell.exec', 'Bash'],
    ['shell.exec', 'Bash'],
    ['shell.exec', 'Bash'],
  ];
  const flags = 'abcdefghijklmnopqrstuvwxyz'.split(/(?:)/u);
  const programs = [...PUBLIC_PROGRAMS];
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor(seed / 65536);
  };
  const framed = frame({ shell: 'bash', day: '2026-11-01', stack: { languages: ['typescript'], frameworks: [], size: null } });
  const calls = Array.from({ length: 3400 }, (_, n) => {
    const [action, native] = natives[next() % natives.length] ?? natives[0] ?? ['other', 'x'];
    const program = programs[next() % programs.length] ?? 'git';
    const subs = [null, ...(PUBLIC_SUBCOMMANDS.get(program) ?? [])];
    const identity = action === 'shell.exec' ? { program, sub: subs[next() % subs.length] ?? null, flags: [`-${flags[next() % flags.length] ?? 'a'}`] } : null;
    return tool('s1', n, native, { steps: [step(n, 0, action, { native, identity })] });
  });
  return oneSkeleton(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: calls }), '0000000000009101');
};

/** The 5,000-shell-call session of `parts.test.ts`. */
const bigBytes = (): number => {
  const framed = frame({ shell: 'bash' });
  const shell = (n: number) => step(n, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] } });
  const calls = Array.from({ length: 5000 }, (_, n) => tool('s1', n, 'Bash', { steps: [shell(n)] }));
  const built = oneSkeleton(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: calls }), '0000000000000001');
  return Buffer.byteLength(canonicalBytes(built), 'utf8');
};

/** The three-prompt fixture of `pool-wire-coverage.test.ts` ("bytes on a fixture that carries a repo key and timestamps"). */
const coverageBytes = (): { bare: number; keyOnly: number; hourOnly: number; both: number; frames: number; timedFrames: number } => {
  const key = '0123456789abcdef';
  const hours = ['2026-11-01T09:10:00.000Z', '2026-11-01T14:20:00.000Z', '2026-11-01T22:30:00.000Z'];
  const skeleton = (repo: string | null, timed: boolean): SessionSkeleton => {
    const framed = frame({ day: '2026-11-01', shell: 'bash' });
    return oneSkeleton(
      store({
        sessions: [session('s1', { frame: framed, repo, tsFirst: timed ? (hours[0] ?? null) : null })],
        prompts: hours.map((ts, index) => prompt('s1', index, { frame: framed, ts: timed ? ts : null })),
        tools: hours.flatMap((_, index) => [0, 1].map((call) => tool('s1', index * 2 + call, 'Read', { steps: [step(index * 2 + call, 0, 'file.read', { native: 'Read' })], prompt: index }))),
      }),
      key,
    );
  };
  const size = (repo: string | null, timed: boolean): number => JSON.stringify(skeleton(repo, timed)).length;
  const framesOf = (timed: boolean): number => {
    const transcript = skeleton(key, timed).transcripts[0];
    return transcript === undefined ? 0 : 1 + transcript.frames.length;
  };
  const bare = size(null, false);
  return { bare, keyOnly: size(key, false) - bare, hourOnly: size(null, true) - bare, both: size(key, true) - bare, frames: framesOf(false), timedFrames: framesOf(true) };
};

interface Figures {
  [id: string]: number;
}

const figures = (): Figures => {
  const large = largeSkeleton();
  const cells = incrementsOf(large).cells;
  const cellJson = JSON.stringify([...cells.values()]).length;
  const skeleton = JSON.stringify(large).length;
  const coverage = coverageBytes();
  const register = Buffer.byteLength(canonicalBytes(REGISTER_FIXTURE), 'utf8');
  const sample = JSON.stringify(sampleSkeleton('0000000000009103')).length;
  const big = bigBytes();
  const perCall = big / 5000;
  return {
    skeleton,
    cells: cells.size,
    'cell-json': cellJson,
    'cell-ratio': cellJson / skeleton,
    // The row the worker stores: the skeleton, the deltas column (`[]`), and the extensions bag (`[]`), two bytes each.
    stored: skeleton + 2 + 2,
    'coverage-bare': coverage.bare,
    'key-cost': coverage.keyOnly,
    'key-per-frame': coverage.keyOnly / coverage.frames,
    'key-timed': coverage.both - coverage.hourOnly,
    'hour-cost': coverage.hourOnly,
    register,
    envelope: envelopeBytes(REGISTER_FIXTURE),
    sample,
    'per-call': perCall,
    big,
    'row-calls': 1_800_000 / perCall,
    'sample-sessions': 10_000_000_000 / sample,
  };
};

interface Marked {
  id: string;
  step: number | null;
  value: number;
  line: number;
}

const MARKER = /(\d[\d,.]*)( million)?<!-- figure:([\w-]+)(?:~([\d.]+))? -->/gu;

const markedFigures = (doc: string): Marked[] =>
  [...doc.matchAll(MARKER)].map((found) => ({
    id: found[3] ?? '',
    step: found[4] === undefined ? null : Number(found[4]),
    value: Number((found[1] ?? '').replaceAll(',', '')) * (found[2] === undefined ? 1 : 1_000_000),
    line: doc.slice(0, found.index).split('\n').length,
  }));

/** A comma-grouped figure with no marker must be a limit or constant the doc names, or follow "about" (a rounded statement, or history of code that no longer exists). */
const CONSTANTS = new Set(['1,000', '5,000', '1,800,000', '2,000,000', '999,999', '100,000', '3,400', '4,096']);

describe('the figures in docs/pool.md', () => {
  const computed = figures();
  const marked = markedFigures(DOC);

  it('equal what the code computes now, exact or within the stated rounding', () => {
    expect(marked.length).toBeGreaterThan(0);
    for (const one of marked) {
      const real = computed[one.id];
      if (real === undefined) throw new Error(`docs/pool.md:${String(one.line)} names figure "${one.id}", which this test does not compute`);
      const expected = one.step === null ? real : Math.round(real / one.step) * one.step;
      expect(Math.abs(one.value - expected) < 1e-6, `docs/pool.md:${String(one.line)} states ${String(one.value)} for "${one.id}", the code computes ${String(real)}`).toBe(true);
    }
  });

  it('holds every figure this test computes, so removing a marker is not silent', () => {
    const named = new Set(marked.map((one) => one.id));
    expect(Object.keys(computed).filter((id) => !named.has(id))).toEqual([]);
  });

  it('has no exact figure left without a marker', () => {
    const bare = [...DOC.matchAll(/(?<!about )(?<![\d,])\d{1,3}(?:,\d{3})+(?![\d,])(?! million)(?!<!-- figure)/gu)].map((found) => found[0]).filter((text) => !CONSTANTS.has(text));
    expect(bare).toEqual([]);
  });
});
