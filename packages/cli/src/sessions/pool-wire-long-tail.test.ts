// t881: the client has one gate. A long-tail name goes on the wire as it is after local redaction; only a value the redactor changes, an exclusion term, a failed name shape, or a name over 128
// characters counts as redacted, and only that case sends `private`. The class of the name (clear, thresholded, hashed) is the pool's to assign (packages/pool/src/field-classes.ts).
import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, store, tool } from './pool-fixture.js';
import { isWireName, isWirePullName, NAME_MAX, parseSkeleton, skeletonOf, wireName, type SessionSkeleton, type WireGate } from './pool-wire.js';
import { shellReader } from './projection.js';
import { LITERAL, PRIVATE } from './public-vocabulary.js';
import { makeRedactor } from './redact.js';
import { readVocabulary } from './vocab-load.js';

const vocab = readVocabulary();
const framed = frame({ shell: 'bash' });
const gate: WireGate = { redact: makeRedactor(), terms: ['acmecorp'] };

type Call = { native: string; steps: ReturnType<typeof step>[]; over?: Parameters<typeof tool>[3] };

const skeletonFor = (calls: Call[], withGate: WireGate = gate): SessionSkeleton | null => {
  const stored = store({
    sessions: [session('s', { frame: framed })],
    prompts: [prompt('s', 0, { frame: framed })],
    tools: calls.map(({ native, steps, over }, at) => tool('s', at, native, { steps, ...over })),
  });
  const [only] = sessionsFrom(stored);
  return only === undefined ? null : skeletonOf(only, '0123456789abcdef', shellReader(vocab), printOf, [], withGate);
};
const stepsOf = (skeleton: SessionSkeleton | null): SessionSkeleton['transcripts'][number]['tools'][number]['steps'] => (skeleton === null ? [] : skeleton.transcripts.flatMap((one) => one.tools.flatMap((each) => each.steps)));
const shell = (program: string, run: string): Call => ({
  native: 'Bash',
  steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: LITERAL, sub: null, flags: [] } })],
  over: { segments: [{ run: `${program} ${run}`.trim(), read: true }] },
});

describe('the wire name shape', () => {
  it('takes a name and refuses a command line, a path, an email, and a name over the limit', () => {
    for (const name of ['kubectl', 'g++', 'python3.11', 'github.com', 'mcp__acme__get_issue', 'a-b_c']) expect(isWireName(name), name).toBe(true);
    for (const name of ['', 'rm -rf x', '/usr/bin/x', 'src/acme/plan.md', '@scope/pkg', 'C:\\x', 'a@b.co', '$(whoami)', 'FOO=bar', 'x'.repeat(NAME_MAX + 1)]) expect(isWireName(name), name).toBe(false);
    expect(isWireName('x'.repeat(NAME_MAX))).toBe(true);
    // Only a pull's package name may hold a `/`, as a scope or a module path.
    for (const name of ['@scope/pkg', 'golang.org/x/tools', 'kubectl']) expect(isWirePullName(name), name).toBe(true);
    for (const name of ['/usr/bin/x', 'a//b', 'C:\\x', 'x'.repeat(NAME_MAX + 1)]) expect(isWirePullName(name), name).toBe(false);
    // The same path is a name nowhere else, and a pull's own shape does not widen the gate for other fields.
    expect(wireName(gate, 'src/acme/plan.md')).toBe(PRIVATE);
    expect(wireName(gate, '@scope/pkg')).toBe(PRIVATE);
    expect(wireName(gate, '@scope/pkg', isWirePullName)).toBe('@scope/pkg');
  });
});

describe('a redacted part inside a name', () => {
  it('counts the name as redacted when a part between underscores is, because the redactor reads an underscore as part of a word', () => {
    const domains: WireGate = { redact: makeRedactor(['acme.internal']), terms: [] };
    expect(wireName(domains, 'mcp__git.acme.internal__run')).toBe(PRIVATE);
    expect(wireName(domains, 'mcp__github__run')).toBe('mcp__github__run');
  });
});

describe('what the client sends after redaction', () => {
  it('sends an off-list program basename, native tool name, MCP server and tool, step skill, and host as they are', () => {
    const skeleton = skeletonFor([
      shell('acme-deploy', '--prod'),
      { native: 'AcmeNativeTool', steps: [step(0, 0, 'other', { native: LITERAL, identity: null })] },
      { native: 'mcp__acme__get_issue', steps: [step(0, 0, 'mcp.call', { native: LITERAL, identity: { server: LITERAL, tool: LITERAL } })] },
      { native: 'Skill', steps: [step(0, 0, 'skill.run', { native: 'Skill', identity: { skill: 'acme-skill' } })], over: { skill: 'acme-run' } },
      { native: 'WebFetch', steps: [step(0, 0, 'web.fetch', { native: 'WebFetch', identity: { host: 'docs.acme.example' } })] },
    ]);
    const sent = stepsOf(skeleton);
    expect(sent[0]?.identity).toEqual({ program: 'acme-deploy', sub: null, flags: [] });
    expect(sent[1]?.native).toBe('AcmeNativeTool');
    expect(sent[2]?.native).toBe('mcp__acme__get_issue');
    expect(sent[2]?.identity).toEqual({ server: 'acme', tool: 'get_issue' });
    expect(sent[3]?.identity).toEqual({ skill: 'acme-skill' });
    expect(sent[3]?.skill).toBe('acme-run');
    expect(sent[4]?.identity).toEqual({ host: 'docs.acme.example' });
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton))).ok).toBe(true);
  });

  it('sends a program as its basename and never its path', () => {
    const sent = stepsOf(skeletonFor([shell('/opt/acme/bin/deploy', '--prod')]));
    expect(sent[0]?.identity).toEqual({ program: 'deploy', sub: null, flags: [] });
  });

  it('sends private for a name holding a token, an email, a path, or an exclusion term', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const skeleton = skeletonFor([
      { native: 'mcp__acmecorp-internal__run', steps: [step(0, 0, 'mcp.call', { native: LITERAL, identity: { server: LITERAL, tool: LITERAL } })] },
      { native: 'Skill', steps: [step(0, 0, 'skill.run', { native: 'Skill', identity: { skill: token } })] },
      { native: 'WebFetch', steps: [step(0, 0, 'web.fetch', { native: 'WebFetch', identity: { host: 'ana@example.com' } })] },
      { native: 'Skill', steps: [step(0, 0, 'skill.run', { native: 'Skill', identity: { skill: '/home/ana/skill' } })] },
      { native: 'AcmeCorpTool', steps: [step(0, 0, 'other', { native: LITERAL, identity: null })] },
      shell('$(rm', '-rf x)'),
      shell('x'.repeat(NAME_MAX + 1), ''),
    ]);
    const sent = stepsOf(skeleton);
    expect(sent[0]?.identity).toEqual({ server: PRIVATE, tool: LITERAL });
    expect(sent[0]?.native).toBe(PRIVATE);
    expect(sent[1]?.identity).toEqual({ skill: PRIVATE });
    expect(sent[2]?.identity).toEqual({ host: PRIVATE });
    expect(sent[3]?.identity).toEqual({ skill: PRIVATE });
    expect(sent[4]?.native).toBe(PRIVATE);
    expect(sent[5]?.identity).toEqual({ program: PRIVATE, sub: null, flags: [] });
    expect(sent[6]?.identity).toEqual({ program: PRIVATE, sub: null, flags: [] });
    const text = JSON.stringify(skeleton);
    expect(text).not.toMatch(/ghp_|ana@|\/home\/ana|acmecorp|AcmeCorp/);
    expect(parseSkeleton(JSON.parse(text)).ok).toBe(true);
  });
});

describe('what the pool takes', () => {
  const sendStep = (identity: unknown, action: string, native: string): unknown => {
    const skeleton = skeletonFor([{ native: 'Bash', steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: null, flags: [] } })] }]);
    const first = skeleton?.transcripts[0]?.tools[0]?.steps[0];
    if (first === undefined) throw new Error('the sample has no step');
    Object.assign(first, { action, native, identity });
    const wire: unknown = JSON.parse(JSON.stringify(skeleton));
    return wire;
  };

  it('accepts a name in each long-tail field and still accepts private from an older client', () => {
    expect(parseSkeleton(sendStep({ program: 'kubectl', sub: null, flags: [] }, 'shell.exec', 'Bash')).ok).toBe(true);
    expect(parseSkeleton(sendStep({ program: PRIVATE, sub: null, flags: [] }, 'shell.exec', 'Bash')).ok).toBe(true);
    expect(parseSkeleton(sendStep({ host: 'docs.acme.example' }, 'web.fetch', 'WebFetch')).ok).toBe(true);
    expect(parseSkeleton(sendStep({ skill: 'acme-skill' }, 'skill.run', 'Skill')).ok).toBe(true);
    expect(parseSkeleton(sendStep({ server: 'acme', tool: 'get_issue' }, 'mcp.call', 'mcp__acme__get_issue')).ok).toBe(true);
    expect(parseSkeleton(sendStep({ host: PRIVATE }, 'web.fetch', 'WebFetch')).ok).toBe(true);
  });

  it('refuses a long-tail value that is no name, by field', () => {
    const refused = parseSkeleton(sendStep({ program: 'rm -rf /', sub: null, flags: [] }, 'shell.exec', 'Bash'));
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toBe('not a name');
    expect(!refused.ok && refused.field).toMatch(/identity\.program$/);
    expect(parseSkeleton(sendStep({ host: 'a b' }, 'web.fetch', 'WebFetch')).ok).toBe(false);
    expect(parseSkeleton(sendStep({ skill: 'x'.repeat(NAME_MAX + 1) }, 'skill.run', 'Skill')).ok).toBe(false);
  });
});
