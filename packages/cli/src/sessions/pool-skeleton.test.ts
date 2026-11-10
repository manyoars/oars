// The deposit's skeleton holds only values that pass their own row (pool vocabulary spec Section 1.2): the leak test runs a captured session through the real projection.
import { describe, expect, it } from 'vitest';
import { cellsOf, projectedStore } from './cell-increments.js';
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
  // A program, MCP server, or pull name is a long-tail name and travels as a name, for the pool to count (it holds it below the floor). A path, an argument, a branch, a token, and a pattern never do. A file's own name and a
  // flag's one-word value are name tokens (layer 2): they travel in `names`, each with its kind, and nowhere else.
  it('leaves none of those bytes anywhere in the batch but a program, server, pull, or native tool name, or a name token', () => {
    const skeleton = capturedSkeleton();
    const named = new Set(['program', 'server', 'native']);
    // `name` is exempt only on a pull (the one object with a `registry` and a `version`; a delta has no `version`), so a delta's `name` is still scanned.
    const scanned = (skip: ReadonlySet<string>): string =>
      JSON.stringify(skeleton, function (this: object, key: string, value: unknown) {
        // A template names its program as a step's identity does, so its first word is exempt like `program`; every other word of it is scanned.
        if (key === 'templates' && Array.isArray(value)) return value.map((template) => String(template).split(' ').slice(1).join(' '));
        return skip.has(key) || (key === 'name' && 'registry' in this && 'version' in this) ? undefined : value;
      }).toLowerCase();
    const text = scanned(named);
    for (const bytes of [PLANTED.toLowerCase(), 'acme-deploy', 'feat/']) expect(text).not.toContain(bytes);
    const apartFromNames = scanned(new Set([...named, 'names']));
    for (const bytes of ['abc123', 'secret.ts']) expect(apartFromNames).not.toContain(bytes);
    // A file's name crosses as a name token. The value after a credential-named flag (`--token abc123`) is no name and crosses nowhere.
    expect(text).toContain('secret.ts');
    expect(text).not.toContain('abc123');
    // The templates hold the program and a public flag, and a slot where each argument stood.
    const templates = skeleton.transcripts.flatMap((transcript) => transcript.tools.flatMap((tool) => tool.templates ?? []));
    expect(templates).toContain(`${PLANTED.toLowerCase()} --token <text>`);
    expect(templates).toContain('git commit -m <text> --amend');
    expect(JSON.stringify(shellIdentities(skeleton))).toContain('"program":"acme-deploy"');
    expect(JSON.stringify(shellIdentities(skeleton))).toContain(`"name":"${PLANTED.toLowerCase()}-pkg"`);
  });

  // Capture stores a skill-run, host, and pull name as it is after redaction, and the one gate sends it: there is no second projection between the transcript and the batch.
  it('carries an off-list skill, host, and pull name from a transcript to the batch as they are', () => {
    const calls = [
      { name: 'Skill', input: { skill: `${PLANTED}-release` } },
      { name: 'WebFetch', input: { url: `https://${PLANTED}.example/plan?token=abc123` } },
      { name: 'Bash', input: { command: `npm install ${PLANTED.toLowerCase()}-pkg@1.2.3` } },
    ];
    const text = [
      JSON.stringify({ type: 'user', uuid: 'u0', timestamp: '2026-11-01T00:00:01.000Z', version: '2.1.300', message: { role: 'user', content: 'go' } }),
      ...calls.map((call, i) => line(i, { type: 'tool_use', id: `t${String(i)}`, ...call })),
    ].join('\n');
    const { tools } = captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: makeRedactor(), salt: 'salt', sid: null, repoRoot: () => null, runtime: { oars: '1.2.3', node: 'v99', os: 'plan9' } });
    const [only] = sessionsFrom(store({ sessions: [session('s', { frame: framed })], prompts: [prompt('s', 0, { frame: framed })], tools }));
    const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', shellReader(vocab), printOf);
    const identities = stepsOf(skeleton).map(({ identity }) => identity);
    expect(identities).toEqual([
      { skill: `${PLANTED}-release` },
      { host: `${PLANTED.toLowerCase()}.example` },
      { program: 'npm', sub: 'install', flags: [], pulls: [{ registry: 'npm', name: `${PLANTED.toLowerCase()}-pkg`, version: '<literal>' }] },
    ]);
    expect(JSON.stringify(skeleton)).not.toMatch(/abc123|plan\?/);
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

  const batchOf = (steps: ReturnType<typeof step>[]): SessionSkeleton | null => {
    const stored = store({
      sessions: [session('s', { frame: framed })],
      prompts: [prompt('s', 0, { frame: framed })],
      tools: steps.map((one, at) => tool('s', at, 'Bash', { steps: [one] })),
    });
    const [only] = sessionsFrom(stored);
    return only === undefined ? null : skeletonOf(only, '0123456789abcdef', shellReader(vocab), printOf);
  };
  const stepsOf = (skeleton: SessionSkeleton | null): SessionSkeleton['transcripts'][number]['tools'][number]['steps'] => (skeleton === null ? [] : skeleton.transcripts.flatMap((one) => one.tools.flatMap((each) => each.steps)));

  // The wire carries a name that passes the gate as it is: the pool holds it below the floor.
  it('sends an off-list MCP server, skill, host, and pull name as they are, and the parser takes the batch', () => {
    const skeleton = batchOf([
      step(0, 0, 'mcp.call', { native: '<literal>', identity: { server: PLANTED, tool: '<literal>' } }),
      step(1, 0, 'skill.run', { native: 'Skill', identity: { skill: PLANTED } }),
      step(2, 0, 'web.fetch', { native: 'WebFetch', identity: { host: `${PLANTED}.internal` } }),
      step(3, 0, 'shell.exec', { native: 'Bash', identity: { program: 'npm', sub: 'install', flags: [], pulls: [{ registry: 'npm', name: PLANTED, version: null }] } }),
    ]);
    expect(stepsOf(skeleton).map(({ native, identity }) => [native, identity])).toEqual([
      ['Bash', { server: PLANTED, tool: '<literal>' }],
      ['Skill', { skill: PLANTED }],
      ['WebFetch', { host: `${PLANTED}.internal` }],
      ['Bash', { program: 'npm', sub: 'install', flags: [], pulls: [{ registry: 'npm', name: PLANTED, version: null }] }],
    ]);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton))).ok).toBe(true);
  });

  // A version beside a masked name identifies the name, so it is masked with it; an MCP tool beside a masked server and a native name the harness table has no row for go the same way.
  it('sends a version beside an off-list pull name as the literal, and a tool beside an off-list server and an off-list native by name', () => {
    const skeleton = batchOf([
      step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'npm', sub: 'install', flags: [], pulls: [{ registry: 'npm', name: 'acme-internal-sdk', version: '7.3.1' }, { registry: 'npm', name: 'acme-other', version: null }] } }),
      step(1, 0, 'mcp.call', { native: '<literal>', identity: { server: 'acme', tool: 'get_issue' } }),
      step(2, 0, 'mcp.call', { native: 'mcp__acme__get_issue', identity: { server: 'acme', tool: 'get_issue' } }),
      step(3, 0, 'skill.run', { native: 'AcmeSecretTool', identity: { skill: 'commit' } }),
    ]);
    expect(stepsOf(skeleton).map(({ native, identity }) => [native, identity])).toEqual([
      ['Bash', { program: 'npm', sub: 'install', flags: [], pulls: [{ registry: 'npm', name: 'acme-internal-sdk', version: '<literal>' }, { registry: 'npm', name: 'acme-other', version: null }] }],
      ['Bash', { server: 'acme', tool: 'get_issue' }],
      ['mcp__acme__get_issue', { server: 'acme', tool: 'get_issue' }],
      ['AcmeSecretTool', { skill: 'commit' }],
    ]);
    expect(JSON.stringify(skeleton)).not.toContain('7.3.1');
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton))).ok).toBe(true);
  });

  it('keeps a listed MCP server, skill, host, and pull name as they are stored', () => {
    const skeleton = batchOf([
      step(0, 0, 'mcp.call', { native: 'mcp__github__get_issue', identity: { server: 'github', tool: 'get_issue' } }),
      step(1, 0, 'web.fetch', { native: 'WebFetch', identity: { host: 'github.com' } }),
      step(2, 0, 'web.search', { native: 'WebSearch', identity: { host: null } }),
      step(3, 0, 'shell.exec', { native: 'Bash', identity: { program: 'npm', sub: 'install', flags: [], pulls: [{ registry: 'npm', name: 'zod', version: null }] } }),
    ]);
    expect(stepsOf(skeleton).map(({ identity }) => identity)).toEqual([
      { server: 'github', tool: 'get_issue' },
      { host: 'github.com' },
      { host: null },
      { program: 'npm', sub: 'install', flags: [], pulls: [{ registry: 'npm', name: 'zod', version: null }] },
    ]);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton))).ok).toBe(true);
  });

  // The older-list case: capture wrote the pull while the program was listed, and the list has since dropped it. The program goes as private, and a private program holds no pull.
  it('sends a stored step whose public program has left the list as private alone, with no pull, and the parser takes the batch', () => {
    const older = step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'acme-deploy', sub: null, flags: [], pulls: [{ registry: 'npm', name: 'zod', version: null }] } });
    const skeleton = batchOf([older]);
    expect(stepsOf(skeleton).map(({ identity }) => identity)).toEqual([{ program: PRIVATE, sub: null, flags: [] }]);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton))).ok).toBe(true);
    // The local read takes the same steps, so it tallies no cell a deposit could not hold.
    const local = store({ sessions: [session('s', { frame: framed })], prompts: [prompt('s', 0, { frame: framed })], tools: [tool('s', 0, 'Bash', { steps: [older] })] });
    const held = cellsOf(projectedStore(local, shellReader(vocab))).motifs.flatMap((motif) => motif.steps);
    expect(held.length).toBeGreaterThan(0);
    expect(held.filter(({ identity }) => identity !== null && 'program' in identity && identity.program === PRIVATE && identity.pulls !== undefined)).toEqual([]);
  });

  it('holds a batch the parser accepts unchanged', () => {
    const skeleton = capturedSkeleton();
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton, extensions: [], others: 0 });
  });

  it('projects `grep <private pattern>` to the program alone, and `acme-deploy` to its basename', () => {
    const [grep, acme] = shellIdentities(capturedSkeleton());
    expect(grep).toEqual({ program: 'grep', sub: null, flags: [] });
    expect(acme).toEqual({ program: 'acme-deploy', sub: null, flags: [] });
  });

  it('keeps a listed subcommand and flag names, and sends an off-list program with neither', () => {
    const identities = shellIdentities(capturedSkeleton());
    expect(JSON.stringify(identities)).toContain('"program":"git","sub":"commit"');
    expect(JSON.stringify(identities)).toContain('--amend');
    expect(identities).toContainEqual({ program: 'acme-deploy', sub: null, flags: [] });
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
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton, extensions: [], others: 0 });
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

  it('puts an empty `deltas` on the form, and refuses an entry that is not one', () => {
    const whole = sample();
    expect(whole).toMatchObject({ format: 7, deltas: [] });
    expect(parseSkeleton({ ...whole, deltas: [{}] })).toMatchObject({ ok: false, field: 'deltas[0].deltaKind' });
    expect(parseSkeleton({ ...whole, format: 1 })).toMatchObject({ ok: false, field: 'format', reason: 'the format 1 form is no longer read; send format 7' });
  });
});
