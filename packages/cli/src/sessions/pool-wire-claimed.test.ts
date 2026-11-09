// The `claimed` field: the host class and launcher a trusted machine states for a batch it admitted from a cloud VM's branch. Every value here is invented.
import { describe, expect, it } from 'vitest';
import { CLAIMED_HOST_CLASSES, CLAIMED_LAUNCHERS, OPTIONAL, parseSkeleton } from './pool-wire.js';
import { REGISTER_FIXTURE } from './pool-fixture.js';

const withClaimed = (claimed: unknown): unknown => ({ ...REGISTER_FIXTURE, claimed });
const parsed = (value: unknown): ReturnType<typeof parseSkeleton> => parseSkeleton(JSON.parse(JSON.stringify(value)));

describe('claimed on the wire', () => {
  it('holds two closed lists: the five host classes of a machine, and the six launchers', () => {
    expect(CLAIMED_HOST_CLASSES).toEqual(['local', 'vps', 'cloud', 'ci', 'hosted']);
    expect(CLAIMED_LAUNCHERS).toEqual(['interactive', 'orchestrated', 'scheduled', 'ci', 'hosted-run', 'unknown']);
  });

  it('is an optional batch field, read into the skeleton with nothing set aside', () => {
    expect(OPTIONAL.batch).toContain('claimed');
    expect(parsed(withClaimed({ hostClass: 'cloud', launcher: 'orchestrated' }))).toMatchObject({ ok: true, extensions: [], others: 0, skeleton: { claimed: { hostClass: 'cloud', launcher: 'orchestrated' } } });
  });

  it('is left out of a batch that does not carry it', () => {
    const result = parsed(Object.fromEntries(Object.entries(REGISTER_FIXTURE).filter(([name]) => name !== 'claimed')));
    expect(result).toMatchObject({ ok: true, extensions: [] });
    expect(result.ok && 'claimed' in result.skeleton).toBe(false);
  });

  it('reads a value off a list as other and bags it at its path, as every closed field does', () => {
    expect(parsed(withClaimed({ hostClass: 'mainframe', launcher: 'ci' }))).toMatchObject({
      ok: true,
      others: 1,
      skeleton: { claimed: { hostClass: 'other', launcher: 'ci' } },
      extensions: [{ at: 'claimed.hostClass', kind: 'value', value: 'mainframe' }],
    });
  });

  it.each([
    { what: 'a null', claimed: null, field: 'claimed' },
    { what: 'a text', claimed: 'cloud', field: 'claimed' },
    { what: 'no launcher', claimed: { hostClass: 'cloud' }, field: 'claimed.launcher' },
    { what: 'no host class', claimed: { launcher: 'ci' }, field: 'claimed.hostClass' },
    { what: 'a host class that is no text', claimed: { hostClass: 3, launcher: 'ci' }, field: 'claimed.hostClass' },
  ])('refuses $what', ({ claimed, field }) => {
    expect(parsed(withClaimed(claimed))).toMatchObject({ ok: false, field });
  });
});
