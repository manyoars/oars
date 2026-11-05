// The wire carries what followed a failed call (t868, Item 3): the actions of up to the next 5 calls of the same prompt and whether an edit was among them. These are what followed, never a fix and
// never a success; no signature hash, command, path, or text crosses.
import { describe, expect, it } from 'vitest';
import type { CanonicalAction } from './actions.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton } from './pool-wire.js';

const framed = frame({ shell: 'bash' });
const NATIVE = { 'file.read': 'Read', 'file.edit': 'Edit', 'file.write': 'Write', 'shell.exec': 'Bash', 'file.search': 'Grep' } as const;
type Used = keyof typeof NATIVE;

const call = (n: number, action: Used, over: Partial<ReturnType<typeof tool>> = {}, identity?: { program: string; sub: string | null; flags: string[] }): ReturnType<typeof tool> =>
  tool('s1', n, NATIVE[action], {
    steps: [step(n, 0, action, { native: NATIVE[action], identity: action === 'shell.exec' ? (identity ?? { program: 'git', sub: 'push', flags: [] }) : null, status: over.status === 'error' ? 'error' : 'ok' })],
    ...over,
  });

const skeletonOf1 = (tools: ReturnType<typeof tool>[]): SessionSkeleton => {
  const from = store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed }), prompt('s1', 1, { frame: framed })], tools });
  const [only] = sessionsFrom(from);
  const built = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

const toolsOf = (skeleton: SessionSkeleton): SessionSkeleton['transcripts'][number]['tools'] => skeleton.transcripts[0]?.tools ?? [];

describe('recoveryCalls on the wire', () => {
  it('lists the actions of the next 5 calls of the same prompt, and holds no more', () => {
    const skeleton = skeletonOf1([
      call(0, 'shell.exec', { status: 'error', errorCode: '1' }),
      call(1, 'file.read'),
      call(2, 'file.search'),
      call(3, 'file.read'),
      call(4, 'shell.exec'),
      call(5, 'file.read'),
      call(6, 'file.read'),
    ]);
    expect(toolsOf(skeleton)[0]?.recoveryCalls).toEqual({ next: ['file.read', 'file.search', 'file.read', 'shell.exec', 'file.read'], editFollowed: false });
  });

  it('stops at the end of the prompt, and says an edit followed when one did', () => {
    const skeleton = skeletonOf1([
      call(0, 'shell.exec', { status: 'error', errorCode: '1' }),
      call(1, 'file.read'),
      call(2, 'file.edit'),
      call(3, 'file.write', { prompt: 1 }),
    ]);
    expect(toolsOf(skeleton)[0]?.recoveryCalls).toEqual({ next: ['file.read', 'file.edit'], editFollowed: true });
  });

  it('holds an empty list for a failed call that nothing followed, and nothing for a call that did not fail', () => {
    const skeleton = skeletonOf1([call(0, 'file.read'), call(1, 'shell.exec', { status: 'error', errorCode: '2' })]);
    expect(toolsOf(skeleton)[0]).not.toHaveProperty('recoveryCalls');
    expect(toolsOf(skeleton)[1]?.recoveryCalls).toEqual({ next: [], editFollowed: false });
  });

  it('counts a call by its first step and a call with no step as other, and skips the calls of another run', () => {
    const skeleton = skeletonOf1([
      call(0, 'shell.exec', { status: 'error', errorCode: '1' }),
      call(1, 'file.read', { side: true }),
      tool('s1', 2, 'Mystery', { steps: [] }),
      call(3, 'file.edit'),
    ]);
    expect(toolsOf(skeleton)[0]?.recoveryCalls).toEqual({ next: ['other', 'file.edit'], editFollowed: true });
  });

  it('carries no signature, command, path, or result text', () => {
    const skeleton = skeletonOf1([call(0, 'shell.exec', { status: 'error', errorCode: '1', target: '/home/me/secret.txt' }), call(1, 'shell.exec', {}, { program: 'git', sub: 'push', flags: [] })]);
    const failed = toolsOf(skeleton)[0]?.recoveryCalls;
    expect(Object.keys(failed ?? {}).sort()).toEqual(['editFollowed', 'next']);
    expect(JSON.stringify(failed)).not.toMatch(/secret|home|git|sig/);
  });

  describe('through the parser', () => {
    const whole = (): SessionSkeleton =>
      skeletonOf1([call(0, 'shell.exec', { status: 'error', errorCode: '1' }), call(1, 'file.read'), call(2, 'file.edit')]);
    const raw = (): SessionSkeleton => whole();
    const recoveryOf = (skeleton: SessionSkeleton): unknown => toolsOf(skeleton)[0]?.recoveryCalls;

    it('round-trips', () => {
      const parsed = parseSkeleton(raw());
      if (!parsed.ok) throw new Error(`refused ${parsed.field}`);
      expect(recoveryOf(parsed.skeleton)).toEqual({ next: ['file.read', 'file.edit'], editFollowed: true });
    });

    it('reads a call that sends none as one with none', () => {
      const bare = raw();
      Reflect.deleteProperty(toolsOf(bare)[0] ?? {}, 'recoveryCalls');
      const parsed = parseSkeleton(bare);
      if (!parsed.ok) throw new Error(`refused ${parsed.field}`);
      expect(recoveryOf(parsed.skeleton)).toBeUndefined();
    });

    const refuse = (change: (first: { recoveryCalls?: unknown }) => void, field: string): void => {
      const bad = raw();
      change(toolsOf(bad)[0] ?? {});
      expect(parseSkeleton(bad)).toMatchObject({ ok: false, field });
    };

    it('refuses a list longer than 5, an action off the list, and a field it does not know', () => {
      const long: CanonicalAction[] = ['file.read', 'file.read', 'file.read', 'file.read', 'file.read', 'file.read'];
      refuse((first) => (first.recoveryCalls = { next: long, editFollowed: false }), 'transcripts[0].tools[0].recoveryCalls.next');
      refuse((first) => (first.recoveryCalls = { next: ['rm -rf /'], editFollowed: false }), 'transcripts[0].tools[0].recoveryCalls.next[0]');
      refuse((first) => (first.recoveryCalls = { next: [], editFollowed: false, sigHash: 'abc' }), 'transcripts[0].tools[0].recoveryCalls.sigHash');
    });

    it('refuses recovery on a call that did not fail, and one that disagrees with the calls that followed', () => {
      const ok = raw();
      Reflect.set(toolsOf(ok)[1] ?? {}, 'recoveryCalls', { next: [], editFollowed: false });
      expect(parseSkeleton(ok)).toMatchObject({ ok: false, field: 'transcripts[0].tools[1].recoveryCalls', reason: 'only a failed call has one' });
      refuse((first) => (first.recoveryCalls = { next: ['file.read'], editFollowed: false }), 'transcripts[0].tools[0].recoveryCalls');
    });
  });
});
