// `derive`'s signature records over a store whose errors mostly share one signature (t1405). The nightly's generated store gives every error one signature (37,332 of them), and `finish` once copied
// that signature's list on every error. The records must be the same whichever way the list grows, so each is compared to one built from a whole-list filter in the test.
import { describe, expect, it } from 'vitest';
import { error, session, store } from './pool-fixture.js';
import { derive, signatureRecord } from './store.js';

const AT = '2026-11-17T00:00:00.000Z';
const HOT = 'Read | KeyError: key';
const OTHERS = ['Edit | no match', 'Bash | exit 1', 'Grep | bad pattern'];

const errors = Array.from({ length: 2_000 }, (_, at) => {
  const sig = at % 500 === 0 ? (OTHERS[(at / 500) % OTHERS.length] ?? HOT) : HOT;
  return error(`s${String(at % 7)}`, sig, { ts: `2026-11-01T10:${String(at % 60).padStart(2, '0')}:00.000Z`, next: at % 3 === 0 ? ['Edit'] : [], editFollowed: at % 4 === 0 });
});
const sessions = Array.from({ length: 7 }, (_, at) => session(`s${String(at)}`));

describe('derive over many errors of one signature', () => {
  // Only the records are pinned. That `finish` appends to a list instead of copying it cannot be seen from outside (the lists are local), so the peak is the measurement, not this test.
  it('gives the records of a whole-list grouping, ordered by sessions, then count, then signature', () => {
    const held = store({ sessions, errors });
    const oracle = [...new Set(errors.map((each) => each.sig))]
      .map((sig) => signatureRecord(sig, errors.filter((each) => each.sig === sig)))
      .sort((a, b) => b.sessions - a.sessions || b.count - a.count || a.sig.localeCompare(b.sig));
    const derived = derive(held, AT).signatures;
    expect(derived).toEqual(oracle);
    expect(derived[0]?.count).toBe(2_000 - 4);
    expect(derived.reduce((sum, record) => sum + record.count, 0)).toBe(2_000);
  });
});
