// Shared fixtures: a small store for the cell and family tests (only the fields a cell or a read looks at, so a test states the calls and prompts that matter to it), and, from the section below, the register, large, big, and coverage fixtures whose sizes docs/pool.md states.
import { deriveCells, poolOf, type Pool } from './cells.js';
import type { CanonicalAction } from './actions.js';
import { FIELD_LIST_VERSION, SKELETON_FORMAT, sessionsOf, skeletonOf, type Print, type SessionRecords, type SessionSkeleton, type ShellReader, type TranscriptRoot } from './pool-wire.js';
import { PUBLIC_PROGRAMS, PUBLIC_SUBCOMMANDS, VOCAB_VERSION } from './public-vocabulary.js';
import { contentHash } from './read.js';
import { createHash } from 'node:crypto';
import type { ErrorObservation, Frame, PromptObservation, SessionObservation, StepObservation, ToolObservation, Usage } from './schema.js';
import type { Store } from './store.js';

export const frame = (over: Partial<Frame> = {}): Frame => ({
  harness: 'claude-code',
  harnessVersion: '2.1.314',
  model: 'claude-opus-5-5',
  effort: 'high',
  day: '2026-11-01',
  platform: 'linux',
  shell: 'Bash',
  stack: { languages: [], frameworks: [], size: null },
  ...over,
});

const USAGE: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 };

export const session = (id: string, over: Partial<SessionObservation> = {}): SessionObservation => ({
  kind: 'session',
  cv: '7',
  sid: 'aaaaaaaa',
  session: id,
  project: 'proj',
  parent: null,
  agentType: null,
  spawnedBy: null,
  spawnedIn: null,
  rev: 1,
  at: '2026-11-01T00:00:00.000Z',
  bytes: 0,
  lines: 0,
  badLines: 0,
  userTurns: 0,
  assistantTurns: 0,
  tsFirst: null,
  tsLast: null,
  versions: [],
  models: {},
  branches: [],
  tools: {},
  files: [],
  fileHashes: [],
  repo: null,
  urls: [],
  searches: [],
  bashCmds: 0,
  tldrs: [],
  confidences: [],
  compactSummaries: 0,
  promptFingerprint: null,
  env: { harness: '2.1.300', oars: '0.0.0', node: '24', os: 'linux' },
  costUsd: null,
  usage: USAGE,
  ...over,
});

export const prompt = (id: string, index: number, over: Partial<PromptObservation> = {}): PromptObservation => ({
  kind: 'prompt',
  v: '9',
  session: id,
  rev: 1,
  index,
  ts: null,
  wallSec: null,
  head: '',
  cls: 'edit-verify',
  tools: [],
  shape: '',
  errors: 0,
  thinking: 0,
  sideTools: 0,
  turns: 0,
  model: 'claude-opus-5-5',
  efforts: ['high'],
  skills: [],
  usage: USAGE,
  recovery: [],
  explore: 0,
  act: 0,
  bigrams: {},
  contextFingerprint: null,
  frame: frame(),
  ...over,
});

export const tool = (id: string, n: number, name: string, over: Partial<ToolObservation> = {}): ToolObservation => ({
  kind: 'tool',
  cv: '7',
  sid: 'aaaaaaaa',
  session: id,
  rev: 1,
  parent: id,
  agentType: null,
  n,
  ts: null,
  tool: name,
  status: 'ok',
  target: null,
  targetBase: null,
  keys: [],
  durationMs: 10,
  toolUseId: `${id}-${String(n)}`,
  harnessVersion: null,
  side: false,
  prompt: 0,
  ...over,
});

export const store = (over: Partial<Store>): Store => ({ sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0, ...over });

export const step = (n: number, seg: number, action: StepObservation['action'], over: Partial<StepObservation> = {}): StepObservation => ({
  n,
  seg,
  action,
  native: 'tool',
  identity: null,
  status: 'ok',
  cost: { tokens: null, durationMs: null },
  parent: null,
  edges: [],
  frameId: 'f',
  ...over,
});

export const error = (id: string, sig: string, over: Partial<ErrorObservation> = {}): ErrorObservation => ({
  kind: 'error',
  v: '9',
  session: id,
  rev: 1,
  ts: '2026-11-01T10:00:00.000Z',
  harnessVersion: null,
  tool: 'Read',
  sig,
  example: sig,
  next: [],
  editFollowed: false,
  prompt: 0,
  cls: 'edit-verify',
  ...over,
});

/** The pool of a fixture store, for a family test to hand its deriver. */
export const poolFrom = (from: Store): Pool => poolOf(deriveCells(from), from.errors);

/** A reader that sends each shell step's own stored identity, for a fixture whose steps already hold public names; the client's reader is the vocabulary projection (`shellReader`). */
export const storedNames: ShellReader = (call) =>
  (call.steps ?? []).map(({ identity }) => (identity !== null && 'program' in identity ? { program: identity.program, subcommand: identity.sub, flags: identity.flags } : { program: 'private', subcommand: null, flags: [] }));

/** A root for every transcript a store holds, as capture would have written one: a hash of the session's id over twelve lines. */
export const rootsOf = (from: Pick<Store, 'sessions' | 'subagents'>): Map<string, TranscriptRoot> =>
  new Map([...from.sessions, ...from.subagents].map(({ session: id }): [string, TranscriptRoot] => [id, { merkleRoot: createHash('sha256').update(id).digest('hex'), leaves: 12 }]));

/** `sessionsOf` over a fixture store with a root for each transcript. */
export const sessionsFrom = (from: Pick<Store, 'sessions' | 'subagents' | 'prompts' | 'tools'>): SessionRecords[] => sessionsOf(from, rootsOf(from));

/** The timing print the client makes. */
export const printOf: Print = contentHash;

// The fixtures whose sizes docs/pool.md states. Each is built once here, and both the test that pins its size and `pool-doc-figures.test.ts` (which holds the doc to that size) import it, so there is one copy.

/** The braces, the commas between top-level fields, and the newline: what no field row holds. */
export const envelopeBytes = (batch: object): number => 2 + Math.max(0, Object.values(batch).filter((held) => held !== undefined).length - 1) + 1;

const REGISTER_FRAME = { harness: 'claude-code', harnessVersion: '2.1.314', model: 'claude-opus-5-5', effort: 'high', day: '2026-11-01', platform: 'linux', shell: 'bash', stack: { languages: ['python'], frameworks: [], size: null, languageShares: [{ language: 'python', languageShare: 'over-50' }, { language: 'other', languageShare: '10-50' }] } };
const REGISTER_COVERAGE = { repoKey: '0123456789abcdef', orgSize: 'unknown', team: 'solo', repoVisibility: 'private', hour: 14 };
const REGISTER_REACH = { filled: true, mcp: ['github'], skills: ['commit'], plugins: ['private'] };
const REGISTER_STEP = { status: 'ok', tokens: 3, ms: 4, remainingTokens: 2, agentType: null, parent: null, frame: 0 };

/** One session at format 3 that holds every field the register names, each once or twice: the register's bytes are measured on this, and say so. */
export const REGISTER_FIXTURE = {
  format: SKELETON_FORMAT,
  vocabVersion: VOCAB_VERSION,
  fieldsVersion: FIELD_LIST_VERSION,
  id: '0123456789abcdef',
  deltas: [{ deltaKind: 'removed', field: 'package', name: 'typescript', registry: 'npm', metric: 'callsPerSession', change: -2 }],
  timingPrint: null,
  transcripts: [
    {
      merkleRoot: 'a'.repeat(64),
      leaves: 12,
      harness: 'claude-code',
      spawnedIn: null,
      frame: { ...REGISTER_FRAME, reach: REGISTER_REACH, ...REGISTER_COVERAGE },
      frames: [{ ...REGISTER_FRAME, reach: REGISTER_REACH, ...REGISTER_COVERAGE }],
      prompts: [{ cls: 'edit-verify', errors: 0, wallSec: 5, usage: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, thinking: 5 }, explore: 6, usageResponses: 2, intervention: 'redo', frame: { ...REGISTER_FRAME, hour: 14 } }],
      tools: [
        {
          side: false,
          prompt: 0,
          status: 'error',
          durationMs: 7,
          errorCode: '429',
          recoveryCalls: { next: ['shell.exec'], editFollowed: false },
          keys: ['file_path'],
          targetClass: 'source',
          argClass: ['path'],
          argFeatures: [{ key: 'file_path', valueSize: '9-32', pathDepth: '1', extension: 'source', dirKind: 'source' }],
          steps: [{ ...REGISTER_STEP, status: 'error', action: 'file.read', native: 'Read', identity: null }],
        },
        {
          side: false,
          prompt: 0,
          status: 'ok',
          durationMs: 7,
          keys: ['command', 'description', 'run_in_background'],
          keysDropped: 1,
          targetClass: 'none',
          argClass: ['command', 'flag', 'text'],
          // The parser does not ask which kind of value holds a pattern, so the fixture carries `patternFeatures` on a key Bash sends.
          argFeatures: [{ key: 'command', valueSize: '9-32', patternFeatures: ['literal'] }],
          argValues: [{ key: 'run_in_background', enumValue: 'true' }],
          changeKind: ['key-added'],
          steps: [
            { ...REGISTER_STEP, allocated: true, skill: 'commit', action: 'shell.exec', native: 'Bash', identity: { program: 'npm', sub: null, flags: [], pulls: [{ registry: 'npm', name: 'zod', version: null }] } },
            { ...REGISTER_STEP, edges: [{ kind: 'next', target: 0 }], action: 'mcp.call', native: 'mcp__github__get_issue', identity: { server: 'github', tool: 'get_issue' } },
            { ...REGISTER_STEP, edges: [{ kind: 'next', target: 1 }, { kind: 'retried', target: 0 }], action: 'skill.run', native: 'Skill', identity: { skill: 'commit' } },
            { ...REGISTER_STEP, action: 'web.fetch', native: 'WebFetch', identity: { host: 'github.com' } },
          ],
        },
      ],
    },
  ],
};

/** The one skeleton a fixture store yields, under `id`. */
export const oneSkeleton = (from: Pick<Store, 'sessions' | 'subagents' | 'prompts' | 'tools'>, id: string): SessionSkeleton => {
  const [only] = sessionsFrom(from);
  const built = only === undefined ? null : skeletonOf(only, id, storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

const LARGE_NATIVES: [CanonicalAction, string][] = [
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

/** The calls in the large deposit (`ingest.test.ts`, "a large deposit"). */
export const LARGE_STEPS = 3400;

/** One prompt of `steps` calls whose actions follow a fixed pseudo-random line, so the windows over it are mostly distinct and so are its cells. */
export const largeSkeleton = (id: string, steps = LARGE_STEPS, perCall = 1): SessionSkeleton => {
  const flags = 'abcdefghijklmnopqrstuvwxyz'.split(/(?:)/u);
  const programs = [...PUBLIC_PROGRAMS];
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    // The high bits: the low bits of this generator cycle with a short period.
    return Math.floor(seed / 65536);
  };
  const framed = frame({ shell: 'bash', day: '2026-11-01', stack: { languages: ['typescript'], frameworks: [], size: null } });
  const observed = Array.from({ length: steps }, (_, n) => {
    const [action, native] = LARGE_NATIVES[next() % LARGE_NATIVES.length] ?? LARGE_NATIVES[0] ?? ['other', 'x'];
    // A program, one of its subcommands, and a short flag, all from the public vocabulary: thousands of identities, so the named windows over them rarely repeat.
    const program = programs[next() % programs.length] ?? 'git';
    const subs = [null, ...(PUBLIC_SUBCOMMANDS.get(program) ?? [])];
    const identity = action === 'shell.exec' ? { program, sub: subs[next() % subs.length] ?? null, flags: [`-${flags[next() % flags.length] ?? 'a'}`] } : null;
    return { native, observed: step(n, n % perCall, action, { native, identity }) };
  });
  // Several steps to a call carry fewer bytes of call wrapper per step, so a deposit can hold more cells' keys under the route's size limit.
  const calls = Array.from({ length: Math.ceil(steps / perCall) }, (_, call) => {
    const held = observed.slice(call * perCall, (call + 1) * perCall);
    return tool('s1', call, held[0]?.native ?? 'x', { steps: held.map(({ observed: one }) => one) });
  });
  return oneSkeleton(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: calls }), id);
};

/** The calls in the big session `docs/pool.md` prices per call, and the one `parts.test.ts` posts in parts. */
export const BIG_CALLS = 5000;

/** One session with `calls` shell calls: each a few hundred bytes of skeleton, so a few thousand pass the request cap (`parts.test.ts`). */
export const bigSkeleton = (id: string, calls: number): SessionSkeleton => {
  const framed = frame({ shell: 'bash' });
  const shell = (n: number) => step(n, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] } });
  return oneSkeleton(
    store({
      sessions: [session('s1', { frame: framed })],
      prompts: [prompt('s1', 0, { frame: framed })],
      tools: Array.from({ length: calls }, (_, n) => tool('s1', n, 'Bash', { steps: [shell(n)] })),
    }),
    id,
  );
};

/** The repo key and the id of the coverage-bytes fixture. */
export const COVERAGE_KEY = '0123456789abcdef';

/** The prompt hours of the coverage-bytes fixture. */
export const COVERAGE_HOURS = ['2026-11-01T09:10:00.000Z', '2026-11-01T14:20:00.000Z', '2026-11-01T22:30:00.000Z'];

/** The three-prompt, six-call skeleton of `pool-wire-coverage.test.ts` ("bytes on a fixture that carries a repo key and timestamps"), with or without a repo key and timestamps. */
export const coverageBytesSkeleton = (repo: string | null, timed: boolean): SessionSkeleton => {
  const framed = frame({ day: '2026-11-01', shell: 'bash' });
  return oneSkeleton(
    store({
      sessions: [session('s1', { frame: framed, repo, tsFirst: timed ? COVERAGE_HOURS[0] ?? null : null })],
      prompts: COVERAGE_HOURS.map((ts, index) => prompt('s1', index, { frame: framed, ts: timed ? ts : null })),
      tools: COVERAGE_HOURS.flatMap((_, index) => [0, 1].map((call) => tool('s1', index * 2 + call, 'Read', { steps: [step(index * 2 + call, 0, 'file.read', { native: 'Read' })], prompt: index }))),
    }),
    COVERAGE_KEY,
  );
};
