// t900: model and version strings, subcommands, and flag names leave the client as the string after the one gate (`wireName`), never a flag value. The class of each is the pool's to assign.
import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, store, tool } from './pool-fixture.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton, type ShellReader, type WireGate } from './pool-wire.js';
import { PRIVATE } from './public-vocabulary.js';
import { makeRedactor } from './redact.js';

const gate: WireGate = { redact: makeRedactor(), terms: ['acmecorp'] };
const ID = '0123456789abcdef';

const skeletonFor = (framed: ReturnType<typeof frame>, read: ShellReader, withGate: WireGate = gate, calls: readonly { model?: string; harnessVersion?: string }[] = []): SessionSkeleton | null => {
  const stored = store({
    sessions: [session('s', { frame: framed })],
    prompts: [prompt('s', 0, { frame: framed })],
    tools: [
      tool('s', 0, 'Bash', { steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'acme-deploy', sub: null, flags: [] } })] }),
      ...calls.map((over, at) => tool('s', at + 1, 'Bash', { steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'acme-deploy', sub: null, flags: [] } })], ...over })),
    ],
  });
  const [only] = sessionsFrom(stored);
  return only === undefined ? null : skeletonOf(only, ID, read, printOf, [], withGate);
};

const readAs = (sub: string | null, flags: readonly string[]): ShellReader => () => [{ program: 'acme-deploy', subcommand: sub, flags }];

describe('model and version strings', () => {
  it('sends an off-list model string and an off-list version string as they are, and parses them', () => {
    const skeleton = skeletonFor(frame({ shell: 'bash', model: 'acme-llm-7', harnessVersion: '9.9.9-acme.1' }), readAs(null, []), gate, [{ model: 'acme-llm-8', harnessVersion: '9.9.9-acme.2' }]);
    const frames = skeleton?.transcripts[0]?.frames ?? [];
    expect(frames.map((one) => [one.model, one.harnessVersion])).toEqual([['acme-llm-7', '9.9.9-acme.1'], ['acme-llm-8', '9.9.9-acme.2']]);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton))).ok).toBe(true);
  });

  it('sends private for a model string holding a path, an email, a token, or an exclusion term', () => {
    for (const model of ['/home/ana/models/x', 'ana@example.com', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'acmecorp-llm', 'two words']) {
      const skeleton = skeletonFor(frame({ shell: 'bash', model, harnessVersion: model }), readAs(null, []));
      const sent = skeleton?.transcripts[0]?.frames[0];
      expect([model, sent?.model, sent?.harnessVersion]).toEqual([model, PRIVATE, PRIVATE]);
      expect(JSON.stringify(skeleton)).not.toContain(model);
    }
  });

  it('keeps a missing model and version null', () => {
    const sent = skeletonFor(frame({ shell: 'bash', model: null, harnessVersion: null }), readAs(null, []))?.transcripts[0]?.frames[0];
    expect([sent?.model, sent?.harnessVersion]).toEqual([null, null]);
  });
});

describe('subcommands and flags of every program', () => {
  it('sends an off-list program subcommand and flag name, and parses them', () => {
    const skeleton = skeletonFor(frame({ shell: 'bash' }), readAs('rollout', ['--prod', '-v']));
    const identity = skeleton?.transcripts[0]?.tools[0]?.steps[0]?.identity;
    expect(identity).toEqual({ program: 'acme-deploy', sub: 'rollout', flags: ['--prod', '-v'] });
    const parsed = parseSkeleton(JSON.parse(JSON.stringify(skeleton)));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.extensions).toEqual([]);
  });

  it('never sends a flag value, and sends private for a subcommand or flag that counts as redacted', () => {
    const skeleton = skeletonFor(frame({ shell: 'bash' }), readAs('acmecorp-plan', ['--token=abc', '--ok', '/x/y', 'a b', '-psecret123', '-uuser:pass', '--password:hunter2', '--user:alice', '-v']));
    const identity = skeleton?.transcripts[0]?.tools[0]?.steps[0]?.identity;
    // A single-dash flag is one letter; a longer single-dash token is a short flag with its value attached, which is never read. A long flag holds no `:` either: `--password:hunter2` is a value joined to its flag.
    expect(identity).toEqual({ program: 'acme-deploy', sub: PRIVATE, flags: [PRIVATE, '--ok', PRIVATE, PRIVATE, PRIVATE, PRIVATE, PRIVATE, PRIVATE, '-v'] });
    expect(JSON.stringify(identity)).not.toMatch(/abc|acmecorp|token|secret123|user:pass|hunter2|password|alice/);
  });

  it('sends a public multi-letter single-dash flag as it is, because the public flag list holds it', () => {
    const read: ShellReader = () => [{ program: 'pwsh', subcommand: null, flags: ['-NoProfile', '-Command', '-psecret123'] }];
    const identity = skeletonFor(frame({ shell: 'bash' }), read)?.transcripts[0]?.tools[0]?.steps[0]?.identity;
    expect(identity).toEqual({ program: 'pwsh', sub: null, flags: ['-NoProfile', '-Command', PRIVATE] });
  });

  it('sends a private program with no subcommand or flag, because the parser refuses a private program that holds one', () => {
    const skeleton = skeletonFor(frame({ shell: 'bash' }), () => [{ program: 'acmecorp-tool', subcommand: 'rollout', flags: ['--prod'] }]);
    expect(skeleton?.transcripts[0]?.tools[0]?.steps[0]?.identity).toEqual({ program: PRIVATE, sub: null, flags: [] });
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton))).ok).toBe(true);
  });

  it('sets aside a subcommand or flag that is no name, with a flag value never read', () => {
    const skeleton = skeletonFor(frame({ shell: 'bash' }), readAs('rollout', ['--prod']));
    const identity = skeleton?.transcripts[0]?.tools[0]?.steps[0]?.identity;
    if (identity === null || identity === undefined || !('flags' in identity)) throw new Error('the sample has no shell identity');
    identity.flags = ['--token=abc'];
    identity.sub = 'two words';
    const parsed = parseSkeleton(JSON.parse(JSON.stringify(skeleton)));
    expect(parsed.ok && parsed.skeleton.transcripts[0]?.tools[0]?.steps[0]?.identity).toEqual({ program: 'acme-deploy', sub: 'other', flags: ['other'] });
  });
});
