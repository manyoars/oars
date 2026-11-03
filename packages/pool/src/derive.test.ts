import { describe, expect, it } from 'vitest';
import { storeOf } from './derive.js';
import { sampleSkeleton } from './sample.js';

describe('storeOf', () => {
  it('turns the position of a spawner back into the address a nested spawn resolves against', () => {
    const skeleton = sampleSkeleton('0123456789abcdef');
    const [main] = skeleton.transcripts;
    if (main === undefined) throw new Error('the sample has no transcript');
    const store = storeOf([{ ...skeleton, transcripts: [main, { ...main, spawnedIn: 0 }, { ...main, spawnedIn: 1 }] }]);
    expect(store.sessions.map((session) => session.spawnedIn)).toEqual([null]);
    expect(store.subagents.map((agent) => [agent.session, agent.spawnedIn])).toEqual([
      ['0123456789abcdef#1', '0123456789abcdef#0'],
      ['0123456789abcdef#2', '0123456789abcdef#1'],
    ]);
  });
});
