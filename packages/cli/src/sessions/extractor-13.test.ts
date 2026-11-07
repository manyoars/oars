// EXTRACTOR 13: a derived prompt carries `intervention`, the bucket of what the next human prompt did to its work (t882). Derived prompts are a pure function of the capture log, so a store written at 12
// is re-derived at 13 from the log alone, and the wire then carries the field for every prompt of it. This is docs/pool.md "Wire field register" rule 7: local store re-derived under the new wire,
// zero unparseable. It reads the repo's fixtures only, staged into a temp store.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalBytes } from './pool-outbox.js';
import { printOf, sessionsFrom, storedNames } from './pool-fixture.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import { EXTRACTOR_VERSION, PROMPT_INTERVENTIONS } from './schema.js';
import { deposit, loadStore, paths, refresh } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const skeletonsOf = (loaded: Awaited<ReturnType<typeof loadStore>>): SessionSkeleton[] =>
  sessionsFrom(loaded).map((records, index) => {
    const built = skeletonOf(records, index.toString(16).padStart(16, '0'), storedNames, printOf);
    if (built === null) throw new Error(`no skeleton for session ${String(index)}`);
    return built;
  });

describe('EXTRACTOR_VERSION 13', () => {
  it('is 13 or later, 13 being the version that gives a derived prompt its intervention', () => {
    expect(Number(EXTRACTOR_VERSION)).toBeGreaterThanOrEqual(13);
  });

  it('re-derives a store written at 12, and every session of it builds, parses with none refused or extended, and holds a listed intervention on every prompt', async () => {
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const derived = paths(staged.storeDir).derived;
    // The store as version 12 left it: records stamped '12', and no `intervention` on any prompt. The transcripts are gone, so nothing can be read from raw.
    const asTwelve = readFileSync(derived, 'utf8')
      .split('\n')
      .map((line) => (line === '' ? line : line.replaceAll(`"v":"${EXTRACTOR_VERSION}"`, '"v":"12"').replace(/,?"intervention":"[a-z-]+"/u, '')))
      .join('\n');
    writeFileSync(derived, asTwelve);
    expect(asTwelve).not.toContain('"intervention"');
    rmSync(staged.projectsRoot, { recursive: true, force: true });
    const stale = await loadStore(staged.storeDir); // a read re-derives from the log, so the 12-stamped file is not what this returns
    expect(stale.prompts.length).toBeGreaterThan(0);

    await refresh(staged.runtime, [], '2026-06-10T00:00:00.000Z');
    expect(readFileSync(derived, 'utf8')).not.toContain('"v":"12"');
    const loaded = await loadStore(staged.storeDir);
    expect(loaded.prompts.length).toBe(stale.prompts.length);

    const skeletons = skeletonsOf(loaded);
    expect(skeletons.length).toBeGreaterThan(0);
    const sent = skeletons.flatMap((skeleton) => skeleton.transcripts.flatMap((transcript) => transcript.prompts));
    expect(sent.length).toBe(loaded.prompts.length);
    for (const skeleton of skeletons) {
      const result = parseSkeleton(JSON.parse(canonicalBytes(skeleton)));
      if (!result.ok) throw new Error(`refused ${result.field}: ${result.reason}`);
      expect(result.extensions).toEqual([]);
      expect(result.skeleton).toEqual(skeleton);
    }
    for (const entry of sent) expect(PROMPT_INTERVENTIONS).toContain(entry.intervention);
  });
});
