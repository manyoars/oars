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
