// What followed a failed call is recomputed at ingest and a list that disagrees is refused. The rule moved at format 6: an edit whose own result was an error wrote nothing, so it no longer counts as an edit that followed.
// A batch of an older format was built under the old rule, which counted any edit, so it is checked with that one and a client already released is not refused for a failed edit. Every name here is invented.
import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton } from './pool-wire.js';

const framed = frame({ shell: 'bash' });
const failedShell = step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] }, status: 'error' });
const failedEdit = step(0, 0, 'file.edit', { native: 'Edit', status: 'error' });
const goodEdit = step(0, 0, 'file.edit', { native: 'Edit' });

/** A batch built now: a failed shell call, then an edit that failed (or one that did not). */
const built = (edit: 'failed' | 'clean'): SessionSkeleton => {
  const tools = [tool('s1', 0, 'Bash', { status: 'error', steps: [failedShell] }), tool('s1', 1, 'Edit', { status: edit === 'failed' ? 'error' : 'ok', steps: [edit === 'failed' ? failedEdit : goodEdit] })];
  const [only] = sessionsFrom(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools }));
  const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (skeleton === null) throw new Error('no skeleton');
  return structuredClone(skeleton);
};

/** The same batch as a client of that format sent it, claiming `editFollowed` as given. */
const sentAt = (format: number, edit: 'failed' | 'clean', editFollowed: boolean): unknown => {
  const skeleton = built(edit);
  const [first, ...rest] = skeleton.transcripts[0]?.tools ?? [];
  if (first === undefined) throw new Error('no call');
  const tools = [{ ...first, recoveryCalls: { next: ['file.edit'], editFollowed } }, ...rest];
  return { ...skeleton, format, transcripts: [{ ...skeleton.transcripts[0], tools }] };
};

const REFUSED = { ok: false, field: 'transcripts[0].tools[0].recoveryCalls', reason: 'not what followed the call' };

describe('the recoveryCalls recompute at ingest', () => {
  it('builds a failed edit as not followed, which the current format accepts', () => {
    expect(built('failed').transcripts[0]?.tools[0]?.recoveryCalls).toEqual({ next: ['file.edit'], editFollowed: false });
    expect(parseSkeleton(sentAt(6, 'failed', false))).toMatchObject({ ok: true });
  });

  it('refuses a current-format batch that counts a failed edit', () => {
    expect(parseSkeleton(sentAt(6, 'failed', true))).toMatchObject(REFUSED);
  });

  it('accepts an old-format batch that counts a failed edit, as the client then built it', () => {
    expect(parseSkeleton(sentAt(5, 'failed', true))).toMatchObject({ ok: true });
    expect(parseSkeleton(sentAt(4, 'failed', true))).toMatchObject({ ok: true });
  });

  it('refuses an old-format batch that leaves a failed edit uncounted, which the old rule never did', () => {
    expect(parseSkeleton(sentAt(5, 'failed', false))).toMatchObject(REFUSED);
  });

  it('reads an edit that did not fail the same at every format', () => {
    for (const format of [4, 5, 6]) {
      expect(parseSkeleton(sentAt(format, 'clean', true)), `format ${String(format)}`).toMatchObject({ ok: true });
      expect(parseSkeleton(sentAt(format, 'clean', false)), `format ${String(format)}`).toMatchObject(REFUSED);
    }
  });
});
