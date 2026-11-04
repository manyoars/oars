// The deposit's skeleton holds only values that pass their own row (pool vocabulary spec Section 1.2): the leak test runs a captured session through the real projection.
import { describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { bucketOf, parseSkeleton, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import { shellReader } from './projection.js';
import { makeRedactor } from './redact.js';
import { PRIVATE } from './public-vocabulary.js';
import { readVocabulary } from './vocab-load.js';

// A fictional name: no real project, person, or customer. It stands for any identifier that must never pool.
const PLANTED = 'AcmeWidgetMerger';
const vocab = readVocabulary();
const framed = frame({ shell: 'bash' });

const COMMANDS = [
  `grep ${PLANTED} src/`,
  'acme-deploy --prod',
  `npm install ${PLANTED.toLowerCase()}-pkg`,
  `git checkout feat/${PLANTED}`,
  `cat /work/${PLANTED}/secret.ts | wc -l`,
  `${PLANTED} --token abc123`,
  `git commit -m "${PLANTED}" --amend`,
];

const line = (i: number, content: unknown): string =>
  JSON.stringify({
    type: 'assistant', uuid: `m${String(i)}`, timestamp: '2026-11-01T00:00:02.000Z', version: '2.1.300', cwd: `/work/${PLANTED}`, gitBranch: `feat/${PLANTED}`,
    message: { role: 'assistant', model: 'm', content: [content], usage: { input_tokens: 1, output_tokens: 1 } },
  });

const sessionText = (): string =>
  [
    JSON.stringify({ type: 'user', uuid: 'u0', timestamp: '2026-11-01T00:00:01.000Z', version: '2.1.300', cwd: `/work/${PLANTED}`, gitBranch: `feat/${PLANTED}`, message: { role: 'user', content: `fix ${PLANTED}` } }),
    ...COMMANDS.map((command, i) => line(i, { type: 'tool_use', id: `t${String(i)}`, name: 'Bash', input: { command } })),
    line(COMMANDS.length, { type: 'tool_use', id: 'tr', name: 'Read', input: { file_path: `/work/${PLANTED}/secret.ts` } }),
    line(COMMANDS.length + 1, { type: 'tool_use', id: 'tm', name: `mcp__${PLANTED}__run`, input: { target: PLANTED } }),
  ].join('\n');

const capture = () => captureSession({ text: sessionText(), session: 's', project: PLANTED, rev: 1, at: 'x', bytes: 1, redact: makeRedactor(), salt: 'salt', sid: null, repoRoot: () => null, runtime: { oars: '1.2.3', node: 'v99', os: 'plan9' } });

const capturedSkeleton = (): SessionSkeleton => {
  const { tools } = capture();
  // Every class A field a record can hold carries the planted name, so a leak through any of them shows in the batch.
  const from = store({
    sessions: [session('s', { frame: framed, project: PLANTED, branches: [`feat/${PLANTED}`], files: [`/work/${PLANTED}/secret.ts`], urls: [`https://${PLANTED}.internal`], searches: [PLANTED], repo: PLANTED })],
    prompts: [prompt('s', 0, { frame: framed, head: `fix ${PLANTED}`, shape: PLANTED })],
    tools,
  });
  const [only] = sessionsFrom(from);
  if (only === undefined) throw new Error('the store has no session');
  const skeleton = skeletonOf(only, '0123456789abcdef', shellReader(vocab), printOf);
  if (skeleton === null) throw new Error('the captured session has no skeleton');
  return skeleton;
};

const shellIdentities = (skeleton: SessionSkeleton): unknown[] => skeleton.transcripts.flatMap(({ tools }) => tools.flatMap(({ steps }) => steps.filter(({ action }) => action === 'shell.exec').map(({ identity }) => identity)));

describe('the leak test: a private name in a path, a program, a package, an argument, and a branch', () => {
  it('leaves none of those bytes anywhere in the batch', () => {
    const text = JSON.stringify(capturedSkeleton()).toLowerCase();
    for (const bytes of [PLANTED.toLowerCase(), 'acme-deploy', 'abc123', 'secret.ts', 'feat/']) expect(text).not.toContain(bytes);
  });

  // Capture already masks what it stores, so the fixture above cannot show projection at work: here the stored step holds the private name itself, as an older or damaged store could.
  it('keeps a private name a stored step identity holds out of the batch, which only the projection can do', () => {
    const stored = store({
      sessions: [session('s', { frame: framed })],
      prompts: [prompt('s', 0, { frame: framed })],
      tools: [
        tool('s', 0, 'Bash', { steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'acme-deploy', sub: PLANTED, flags: [`--${PLANTED}`, '--force'] } })] }),
        tool('s', 1, 'Bash', { steps: [step(1, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: PLANTED, flags: [`--${PLANTED}`, '--force'] } })] }),
      ],
    });
    const [only] = sessionsFrom(stored);
    const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', shellReader(vocab), printOf);
    expect(JSON.stringify(skeleton).toLowerCase()).not.toContain(PLANTED.toLowerCase());
    expect(JSON.stringify(skeleton).toLowerCase()).not.toContain('acme');
    expect(skeleton === null ? [] : shellIdentities(skeleton)).toEqual([
      { program: PRIVATE, sub: null, flags: [] },
      { program: 'git', sub: null, flags: ['--force'] },
    ]);
  });

  // `projectedSteps` copies a stored pull through, so it is the parser that keeps a private package name off the wire: a batch holding one is refused, never sent.
  it('refuses a batch whose stored pull holds a private package name', () => {
    const stored = store({
      sessions: [session('s', { frame: framed })],
      prompts: [prompt('s', 0, { frame: framed })],
      tools: [tool('s', 0, 'Bash', { steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'npm', sub: 'install', flags: [], pulls: [{ registry: 'npm', name: PLANTED, version: null }] } })] })],
    });
    const [only] = sessionsFrom(stored);
    const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', shellReader(vocab), printOf);
    const parsed = parseSkeleton(JSON.parse(JSON.stringify(skeleton)));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.field).toContain('pulls');
  });

  it('holds a batch the parser accepts unchanged', () => {
    const skeleton = capturedSkeleton();
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton });
  });

  it('projects `grep <private pattern>` to the program alone, and `acme-deploy` to private', () => {
    const [grep, acme] = shellIdentities(capturedSkeleton());
    expect(grep).toEqual({ program: 'grep', sub: null, flags: [] });
    expect(acme).toEqual({ program: PRIVATE, sub: null, flags: [] });
  });

  it('keeps a listed subcommand and flag names, and sends a private program with neither', () => {
    const identities = shellIdentities(capturedSkeleton());
    expect(JSON.stringify(identities)).toContain('"program":"git","sub":"commit"');
    expect(JSON.stringify(identities)).toContain('--amend');
    expect(identities).toContainEqual({ program: PRIVATE, sub: null, flags: [] });
  });
});

describe('the leak test: the name of a custom subagent', () => {
  const PRIVATE_AGENT = 'acme-release-captain';

  it('leaves as custom on every step of its run, and nowhere else in the batch', () => {
    const [only] = sessionsFrom(
      store({
        sessions: [session('s1', { frame: framed })],
        subagents: [session('s1~a', { parent: 's1', spawnedIn: 's1', agentType: PRIVATE_AGENT, frame: framed })],
        prompts: [prompt('s1', 0, { frame: framed }), prompt('s1~a', 0, { frame: framed })],
        tools: [
          tool('s1', 0, 'Bash', { steps: [step(0, 0, 'shell.exec', { native: 'Bash' })] }),
          tool('s1~a', 0, 'Bash', { steps: [step(0, 0, 'shell.exec', { native: 'Bash' }), step(0, 1, 'shell.exec', { native: 'Bash' })] }),
          tool('s1~a', 1, 'Bash', { steps: [step(1, 0, 'shell.exec', { native: 'Bash' })] }),
        ],
      }),
    );
    if (only === undefined) throw new Error('the store has no session');
    const skeleton = skeletonOf(only, '0123456789abcdef', storedNames, printOf);
    if (skeleton === null) throw new Error('no skeleton');
    const types = (skeleton.transcripts[1]?.tools ?? []).flatMap(({ steps }) => steps.map(({ agentType }) => agentType));
    expect(types).toEqual(['custom', 'custom', 'custom']);
    expect(JSON.stringify(skeleton).toLowerCase()).not.toContain('acme');
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton });
  });
});

describe('what a batch sends in place of a count', () => {
  const sample = (): SessionSkeleton => {
    const from = store({
      sessions: [session('s1', { frame: framed })],
      prompts: [prompt('s1', 0, { frame: framed, errors: 4, wallSec: 37, thinking: 6, usage: { input: 123456, cacheWrite: 1500, cacheRead: 987654, output: 4321, thinking: 5000 } })],
      tools: [
        tool('s1', 0, 'Bash', {
          durationMs: 777,
          steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] }, cost: { tokens: 98765, durationMs: 4321 } })],
        }),
      ],
    });
    const [only] = sessionsFrom(from);
    if (only === undefined) throw new Error('the store has no session');
    const skeleton = skeletonOf(only, '0123456789abcdef', storedNames, printOf);
    if (skeleton === null) throw new Error('the sample has no skeleton');
    return skeleton;
  };

  it('sends usage, errors, wall time, and a step cost as buckets by the Section 7 edges', () => {
    const [transcript] = sample().transcripts;
    const [sentPrompt] = transcript?.prompts ?? [];
    expect(sentPrompt?.usage).toEqual({
      input: bucketOf('tokens', 123456),
      cacheWrite: bucketOf('tokens', 1500),
      cacheRead: bucketOf('tokens', 987654),
      output: bucketOf('tokens', 4321),
      thinking: bucketOf('tokens', 5000),
    });
    expect(sentPrompt?.usage).toEqual({ input: 7, cacheWrite: 1, cacheRead: 10, output: 3, thinking: 3 });
    expect(sentPrompt?.errors).toBe(3);
    expect(sentPrompt?.wallSec).toBe(6);
    const [sentStep] = transcript?.tools[0]?.steps ?? [];
    expect(sentStep?.tokens).toBe(bucketOf('tokens', 98765));
    expect(sentStep?.ms).toBe(bucketOf('ms', 4321));
  });

  it('puts no token count, byte count, or duration on the wire but the exact time per tool step that Section 1.2 names', () => {
    // A root is 64 hex digits, which can hold any two digits between letters: only the counts are scanned.
    const text = JSON.stringify(sample()).replace(/"merkleRoot":"[0-9a-f]{64}"/g, '"merkleRoot":""');
    for (const exact of ['123456', '1500', '987654', '4321', '98765', '37']) expect(text).not.toMatch(new RegExp(`[^0-9]${exact}[^0-9]`));
    expect(JSON.parse(text)).toMatchObject({ transcripts: [{ tools: [{ durationMs: 777 }] }] });
  });

  it('puts an empty `deltas` on the form, and refuses a non-empty one', () => {
    const whole = sample();
    expect(whole).toMatchObject({ format: 2, deltas: [] });
    expect(parseSkeleton({ ...whole, deltas: [{}] })).toMatchObject({ ok: false, field: 'deltas' });
    expect(parseSkeleton({ ...whole, format: 1 })).toMatchObject({ ok: false, field: 'format', reason: 'the exact-count form (format 1) is no longer read; send format 2' });
  });
});
