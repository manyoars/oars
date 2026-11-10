// Stand-in covenant texts for the test Worker. The pool refuses an acceptance for a version it holds no text for, so the harness bundles this module in place of `covenant-texts.ts` (`startPool`), and a test accepts with the body `acceptanceOf(version)`, which names the hash of the text the Worker holds. The wording of a real covenant is not in this file; a test needs only the shape.
// It imports nothing from the pool: the Worker bundle includes it.
import { createHash } from 'node:crypto';

/** The phrase a person types to accept, as the stand-in screen states it. */
export const TEST_PHRASE = 'I AGREE';

/** A screen under a placeholder wording, carrying the link line and the phrase line a screen must have. */
export const testScreen = (version: string): string =>
  [`TEST COVENANT ${version}`, '', 'This text stands in for a covenant in a test.', '', `Full text: https://pool.test/covenant/${version}`, '', `To accept, type: ${TEST_PHRASE}`].join('\n');

/** The versions a test pool runs under: the harness default and the one the covenant tests set. */
export const COVENANT_TEXTS: ReadonlyMap<string, string> = new Map(['v1', 'v2'].map((version) => [version, testScreen(version)]));

/** The body of an acceptance as the client sends it after a person typed the phrase. */
export const acceptanceOf = (version = 'v1'): { version: string; textSha256: string; input: string; client: string; euEeaUk: string } => ({
  version,
  textSha256: createHash('sha256').update(testScreen(version)).digest('hex'),
  input: 'typed',
  client: 'oars/test',
  euEeaUk: 'no',
});
