// The wire tells a user refusal, a policy denial, and a real failure apart with a closed `errorCode` (t868, Item 1). The code is the tool's projected class; no result text crosses.
import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { parseSkeleton, skeletonOf, SKELETON_FORMAT, type SessionSkeleton } from './pool-wire.js';

const framed = frame({ shell: 'bash' });
const shell = step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] } });
const failed = step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] }, status: 'error' });

const skeletonOf1 = (tools: ReturnType<typeof tool>[]): SessionSkeleton => {
  const from = store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools });
  const [only] = sessionsFrom(from);
  const built = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

const call = (n: number, over: Partial<ReturnType<typeof tool>>): ReturnType<typeof tool> => tool('s1', n, 'Bash', { steps: [over.status === 'error' ? failed : shell], ...over });

const codes = (skeleton: SessionSkeleton): (string | null | undefined)[] => skeleton.transcripts[0]?.tools.map(({ errorCode }) => errorCode) ?? [];

describe('errorCode on the wire', () => {
  it('is skeleton format 3', () => {
    expect(SKELETON_FORMAT).toBe(3);
  });

  it('refuses format 2 by name, as it refuses format 1', () => {
    const whole = skeletonOf1([call(0, { status: 'ok' })]);
    expect(parseSkeleton({ ...whole, format: 2 })).toMatchObject({ ok: false, field: 'format', reason: 'the format 2 form is no longer read; send format 3' });;
  });

  it('sends the class of each failed call and null for a call that did not fail', () => {
    const skeleton = skeletonOf1([call(0, { status: 'error', errorCode: 'user-rejected' }), call(1, { status: 'error', errorCode: 'permission-denied' }), call(2, { status: 'error', errorCode: '1' }), call(3, { status: 'ok' })]);
    expect(codes(skeleton)).toEqual(['user-rejected', 'permission-denied', '1', null]);
  });

  it('sends null for a failed call whose capture holds no code, and other for a class outside the closed list', () => {
    const skeleton = skeletonOf1([call(0, { status: 'error' }), call(1, { status: 'error', errorCode: 'ENOENT: no such file /home/me/x' })]);
    expect(codes(skeleton)).toEqual([null, 'other']);
    expect(JSON.stringify(skeleton)).not.toContain('/home/me');
  });

  it('keeps a user refusal, a policy denial, and a real failure distinct through a round trip', () => {
    const skeleton = skeletonOf1([call(0, { status: 'error', errorCode: 'user-rejected' }), call(1, { status: 'error', errorCode: 'permission-denied' }), call(2, { status: 'error', errorCode: '429' })]);
    const parsed = parseSkeleton(JSON.parse(JSON.stringify(skeleton)));
    if (!parsed.ok) throw new Error(`refused ${parsed.field}`);
    expect(codes(parsed.skeleton)).toEqual(['user-rejected', 'permission-denied', '429']);
  });

  it('reads a value outside the closed list as other and keeps it in the extensions bag, and refuses a value that is no text with the field named', () => {
    const raw = skeletonOf1([call(0, { status: 'error', errorCode: '1' })]);
    const tools = raw.transcripts[0]?.tools ?? [];
    for (const sent of ['ENOENT', '', 'Exit code 1']) {
      Reflect.set(tools[0] ?? {}, 'errorCode', sent);
      const parsed = parseSkeleton(raw);
      if (!parsed.ok) throw new Error(`refused ${parsed.field}`);
      expect(codes(parsed.skeleton)).toEqual(['other']);
      expect(parsed.extensions).toEqual([{ at: 'transcripts[0].tools[0].errorCode', kind: 'value', value: sent }]);
      expect(parsed.others).toBe(1);
    }
    Reflect.set(tools[0] ?? {}, 'errorCode', 7);
    expect(parseSkeleton(raw)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].errorCode', reason: 'not text' });
  });

  it('refuses a code on a call that did not fail', () => {
    const raw = skeletonOf1([call(0, { status: 'ok' })]);
    Reflect.set(raw.transcripts[0]?.tools[0] ?? {}, 'errorCode', '1');
    expect(parseSkeleton(raw)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].errorCode', reason: 'only a failed call has one' });
  });

  it('reads a call that sends no errorCode as one with none', () => {
    const raw = skeletonOf1([call(0, { status: 'error', errorCode: '1' })]);
    Reflect.deleteProperty(raw.transcripts[0]?.tools[0] ?? {}, 'errorCode');
    const parsed = parseSkeleton(raw);
    if (!parsed.ok) throw new Error(`refused ${parsed.field}`);
    expect(codes(parsed.skeleton)).toEqual([null]);
  });
});
