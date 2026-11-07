// EXTRACTOR 14: `intervention` gains `user-stop` (t912), so a prompt the human stopped is derived under the new rule from the capture log alone. This is section 17 rule 7 of the direction conclusion
// (round trip: local store re-derived under the new wire, zero unparseable). It reads the repo's fixtures only, staged into a temp store with one more session that holds a rejection and an interrupt.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalBytes } from './pool-outbox.js';
import { printOf, sessionsFrom, storedNames } from './pool-fixture.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import { EXTRACTOR_VERSION, PROMPT_INTERVENTIONS, type PromptIntervention } from './schema.js';
import { deposit, loadStore, paths, refresh } from './store.js';
import { addProject, cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const REJECTION = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
const STOPS = [
  { type: 'user', timestamp: '2026-06-01T10:00:01.000Z', message: { role: 'user', content: 'change the field' } },
  { type: 'assistant', timestamp: '2026-06-01T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' } }] } },
  { type: 'user', timestamp: '2026-06-01T10:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: REJECTION }] } },
  { type: 'user', timestamp: '2026-06-01T10:00:04.000Z', message: { role: 'user', content: 'try the other way' } },
  { type: 'assistant', timestamp: '2026-06-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'user', timestamp: '2026-06-01T10:00:06.000Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  { type: 'user', timestamp: '2026-06-01T10:00:07.000Z', message: { role: 'user', content: 'stop, go on' } },
].map((line) => JSON.stringify(line));

const skeletonsOf = (loaded: Awaited<ReturnType<typeof loadStore>>): SessionSkeleton[] =>
  sessionsFrom(loaded).map((records, index) => {
    const built = skeletonOf(records, index.toString(16).padStart(16, '0'), storedNames, printOf);
    if (built === null) throw new Error(`no skeleton for session ${String(index)}`);
    return built;
  });

describe('EXTRACTOR_VERSION 14', () => {
  it('is 14 or later, 14 being the version that reads a stop as user-stop', () => {
    expect(Number(EXTRACTOR_VERSION)).toBeGreaterThanOrEqual(14);
  });

  it('re-derives a store written at 13, where a stop read unknown, and every session of it builds, parses with none refused or extended, and holds a listed intervention on every prompt', async () => {
    const staged = stage();
    addProject(staged, 'proj', 'stops', STOPS);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const derived = paths(staged.storeDir).derived;
    // The store as version 13 left it: `derived.json` stamped '13'. Derived prompts are not kept in that file; a read derives them from the capture log, so a stopped prompt reads under the new rule at once.
    const asThirteen = readFileSync(derived, 'utf8').replaceAll(`"v":"${EXTRACTOR_VERSION}"`, '"v":"13"');
    writeFileSync(derived, asThirteen);
    expect(asThirteen).not.toContain(`"v":"${EXTRACTOR_VERSION}"`);
    rmSync(staged.projectsRoot, { recursive: true, force: true });
    const stale = await loadStore(staged.storeDir); // a read derives from the log, so the 13-stamped file is not what this returns
    expect(stale.prompts.length).toBeGreaterThan(0);

    await refresh(staged.runtime, [], '2026-06-10T00:00:00.000Z');
    expect(readFileSync(derived, 'utf8')).not.toContain('"v":"13"');
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
    // The two stopped prompts of the added session carry the new member on the wire.
    expect(sent.filter((entry) => entry.intervention === 'user-stop')).toHaveLength(2);
  });

  it('counts the buckets of the repo fixtures plus the stop session, for the report', async () => {
    const staged = stage();
    addProject(staged, 'proj', 'stops', STOPS);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const counts = new Map<PromptIntervention, number>();
    for (const prompt of (await loadStore(staged.storeDir)).prompts) if (prompt.intervention !== undefined) counts.set(prompt.intervention, (counts.get(prompt.intervention) ?? 0) + 1);
    expect(Object.fromEntries(PROMPT_INTERVENTIONS.map((bucket) => [bucket, counts.get(bucket) ?? 0]))).toEqual({ none: 3, 'after-error': 0, redo: 0, revert: 0, 'user-stop': 2, unknown: 6 });
  });
});
