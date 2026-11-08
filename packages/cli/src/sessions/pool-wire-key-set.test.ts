// The bundle's key set (S17): a bundle is checked against the key its `kid` names, from the keys pinned at login and the keys a release of oars ships. Every key here is generated for the test.
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { unpinnedKid, verifyBundle, VOCAB_VERSION, type PinnedKey, type PinnedKeys } from './pool-wire.js';

const keyPair = async (): Promise<{ pinned: PinnedKey; sign: (text: string) => Promise<string> }> => {
  const pair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('no key pair');
  const { x } = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    pinned: { kty: 'OKP', crv: 'Ed25519', x: x ?? '' },
    sign: async (text) => Buffer.from(await webcrypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(text))).toString('base64'),
  };
};

const payload = JSON.stringify({ format: 1, harness: 'claude-code', harnessVersion: '2.1.314', vocabVersion: VOCAB_VERSION, floor: 5, asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: [{}], strata: [] });
type Answer = Awaited<ReturnType<typeof verifyBundle>>;
const refusedWith = (answer: Answer, text: string): boolean => !answer.ok && answer.reason.includes(text);
const NONE: PinnedKeys = {};
const NO_RETIRED: ReadonlySet<string> = new Set<string>();

describe('verifyBundle: the key set', () => {
  it('verifies a bundle with the key a release of oars ships, when the login pinned only another id', async () => {
    const [first, next] = [await keyPair(), await keyPair()];
    const signed = { kid: 'k2', payload, signature: await next.sign(payload) };
    expect(await verifyBundle(signed, { k1: first.pinned }, 'claude-code', '2.1.314', NO_RETIRED, { k2: next.pinned })).toMatchObject({ ok: true });
    expect(refusedWith(await verifyBundle(signed, { k1: first.pinned }, 'claude-code', '2.1.314', NO_RETIRED, NONE), 'key k2')).toBe(true);
  });

  it('lets a shipped key win over a pinned one under the same id, so the pinned copy cannot shadow it', async () => {
    const [pinned, released] = [await keyPair(), await keyPair()];
    const byPinned = { kid: 'k1', payload, signature: await pinned.sign(payload) };
    expect(refusedWith(await verifyBundle(byPinned, { k1: pinned.pinned }, 'claude-code', '2.1.314', NO_RETIRED, { k1: released.pinned }), 'does not match the key k1')).toBe(true);
    const byReleased = { kid: 'k1', payload, signature: await released.sign(payload) };
    expect(await verifyBundle(byReleased, { k1: pinned.pinned }, 'claude-code', '2.1.314', NO_RETIRED, { k1: released.pinned })).toMatchObject({ ok: true });
  });

  it('refuses a retired id even when its key is pinned, and a kid that is no name shape without echoing it', async () => {
    const one = await keyPair();
    const signed = { kid: 'k1', payload, signature: await one.sign(payload) };
    expect(refusedWith(await verifyBundle(signed, { k1: one.pinned }, 'claude-code', '2.1.314', new Set(['k1']), NONE), 'no longer trusts')).toBe(true);
    const odd = await verifyBundle({ ...signed, kid: 'k 1\nx' }, { k1: one.pinned }, 'claude-code', '2.1.314', NO_RETIRED, NONE);
    expect(refusedWith(odd, '(unreadable key id)')).toBe(true);
  });
});

describe('unpinnedKid', () => {
  const key: PinnedKey = { kty: 'OKP', crv: 'Ed25519', x: 'x' };
  it('names the first offered id that is neither held nor shipped in a release', () => {
    expect(unpinnedKid({ k1: key }, { k1: key }, NONE)).toBeUndefined();
    expect(unpinnedKid({ k1: key }, { k1: key, k2: key }, NONE)).toBe('k2');
    expect(unpinnedKid({ k1: key }, { k2: key }, { k2: key })).toBeUndefined();
  });
});
