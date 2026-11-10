// A recommendation's exposure survives the deposit. Three sessions of one local store, one given a recommendation, one held back from one, and one with no row, go through the client's derivation and serialization, the Worker's ingest, and the signed
// bundle the pool serves. Shown stays shown, held stays held, and missing stays unknown. The floors are set to 1 so one account's cells are served. Every id and version here is invented.
import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from '../../cli/src/sessions/pool-fixture.js';
import { NO_COVERAGE, OPEN_GATE, parseSkeleton, recommendationsOf, skeletonOf, verifyBundle, VOCAB_VERSION, type Bundle, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { deriveConsequences } from '../../cli/src/sessions/recall-consequence.js';
import { makeRecall, type Recall } from '../../cli/src/sessions/recall-object.js';
import { acceptanceOf, fieldOf, startPool, stubUser, type TestPool } from './test-pool.js';

const framed = frame({ shell: 'bash', day: '2026-11-02' });
const VERSION = '2026-11-03T03:00:00.000Z';
const AT = '2026-11-02T10:00:00.500Z';

/** One recommendation of the session, drawn into `arm`, stamped between its first and second call. */
const recommended = (sid: string, arm: Recall['arm']): Recall =>
  makeRecall({ sid, at: AT, frame: null, mode: 'push', query: { form: 'pattern', prefix: ['shape'] }, poolVersion: VERSION, arm, reads: ['r1'], rendered: 'advice', names: ['file.read'], evidence: [] });

/** Four reads of one prompt, a second apart, so a recommendation stamped after the first read covers the three after it. */
const local = (sid: string): ReturnType<typeof store> =>
  store({
    sessions: [session(sid, { frame: framed })],
    prompts: [prompt(sid, 0, { frame: framed })],
    tools: [0, 1, 2, 3].map((n) => tool(sid, n, 'Read', { prompt: 0, ts: `2026-11-02T10:00:0${String(n)}.000Z`, steps: [step(n, 0, 'file.read', { native: 'Read' })] })),
  });

/** The client's path: the local rows get their windows (`deriveConsequences`), the skeleton carries the session's recommendations, and the body is what `JSON.stringify` sends. */
const sentFor = (sid: string, key: string, rows: readonly Recall[]): SessionSkeleton => {
  const records = local(sid);
  const [only] = sessionsFrom(records);
  const built = only === undefined ? null : skeletonOf(only, key, storedNames, printOf, [], OPEN_GATE, NO_COVERAGE, recommendationsOf(deriveConsequences(records, rows), sid));
  if (built === null) throw new Error('no skeleton');
  const parsed = parseSkeleton(JSON.parse(JSON.stringify(built)));
  if (!parsed.ok) throw new Error(`${parsed.field}: ${parsed.reason}`);
  return parsed.skeleton;
};

const bundleFor = async (target: TestPool, token: string): Promise<Bundle> => {
  const { status, json } = await target.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, token);
  expect(status).toBe(200);
  const verified = await verifyBundle(json, target.pinned(), 'claude-code', '2.1.314');
  if (!verified.ok) throw new Error(verified.reason);
  return verified.bundle;
};

describe('exposure from a local store to the served cell', () => {
  it('keeps shown shown, held held, and a session with no row unknown', async () => {
    const target = await startPool({ PUBLIC_FLOOR: '1', DISCLOSURE_FLOOR: '1', CLEAR_FLOOR: '1' });
    try {
      const { token } = await target.signIn('github', stubUser('8801'));
      await target.post('/v1/covenant/accept', acceptanceOf('v1'), token);
      const sends: [string, string, Recall[]][] = [
        ['s-shown', '00000000000a8801', [recommended('s-shown', 'shown')]],
        ['s-held', '00000000000a8802', [recommended('s-held', 'held')]],
        ['s-none', '00000000000a8803', []],
      ];
      for (const [sid, key, rows] of sends) expect((await target.post('/v1/deposits', sentFor(sid, key, rows), token)).status).toBe(201);

      // The stored cells: the live (day) cell of the read, one row per reading, and the old column set for a shown row alone.
      const db = await target.db();
      const stored = (await db.prepare("SELECT exposure, exposed, ok, key FROM cells WHERE grain = 'day' ORDER BY exposure").all()).results.map((held) => ({ exposure: fieldOf(held, 'exposure'), exposed: fieldOf(held, 'exposed'), ok: fieldOf(held, 'ok'), code: String(fieldOf(held, 'key')).split('/').at(-1) }));
      expect(stored).toEqual([
        { exposure: 'held', exposed: 0, ok: 3, code: '2' },
        { exposure: 'shown', exposed: 1, ok: 3, code: '1' },
        { exposure: 'unknown', exposed: 0, ok: 6, code: '0' },
      ]);

      // The served cells say the same: the held session is not folded into the unknown cell, and nothing reads as unexposed.
      const served = (await bundleFor(target, token)).cells.filter((cell) => cell.grain === 'day');
      expect(served.map(({ exposure, exposed, ok }) => ({ exposure, exposed, ok })).sort((a, b) => (a.exposure ?? '').localeCompare(b.exposure ?? ''))).toEqual([
        { exposure: 'held', exposed: false, ok: 3 },
        { exposure: 'shown', exposed: true, ok: 3 },
        { exposure: 'unknown', exposed: false, ok: 6 },
      ]);
    } finally {
      await target.dispose();
    }
  }, 120_000);
});
